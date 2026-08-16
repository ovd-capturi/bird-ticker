//! DOFbasen observation scraping — port of `parseObservationsHtml` and the
//! lighter `fetchObsData` from `proxy/server.js`.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use scraper::{ElementRef, Html, Selector};

use super::Observation;

/// Species-block delimiter. Groups: 1=artId, 2=fullTitle, 3=cssClass,
/// 4=danishName, 5=latinName. SU (rarity) species are wrapped in square
/// brackets and carry a parenthesised `(SU)` marker between the name link and
/// the latin name — e.g. `[<span class="su">Munkegrib</span></a>] (SU)
/// (<i>Aegypius monachus</i>):` — so the closing `]` and marker are tolerated
/// here. Ordinary species have neither and match the same pattern.
static SPECIES_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"<a[^>]*class="arter"[^>]*href="[^"]*art=(\d+)[^"]*"[^>]*title="Alle observationer af ([^"]+)"[^>]*><span class="(defaultart|subart|su|seasonart)">([^<]+)</span></a>\]?\s*(?:\([^)]*\)\s*)?\(<i>([^<]+)</i>\):"#,
    )
    .unwrap()
});
static LOKNR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"loknr=(\d+)").unwrap());
static POS_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"lng=([\d,]+)&lat=([\d,]+)").unwrap());

/// True ISO-8859-1: each byte maps to the same Unicode code point. Matches
/// `iconv-lite`'s latin1 (unlike WHATWG's windows-1252 remap of 0x80–0x9F).
pub fn decode_latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}

struct Block {
    index: usize,
    art_id: String,
    css_class: String,
    danish: String,
    latin: String,
}

/// `parseInt(s, 10) || 0` — leading optional sign then digits, else 0.
fn parse_int_prefix(s: &str) -> i32 {
    let t = s.trim();
    let mut out = String::new();
    let mut chars = t.chars().peekable();
    if let Some(&c) = chars.peek() {
        if c == '-' || c == '+' {
            out.push(c);
            chars.next();
        }
    }
    while let Some(&c) = chars.peek() {
        if c.is_ascii_digit() {
            out.push(c);
            chars.next();
        } else {
            break;
        }
    }
    out.parse().unwrap_or(0)
}

fn parse_coord(s: &str) -> Option<f64> {
    s.replace(',', ".").parse().ok()
}

/// True for src values that look like an actual photo, so layout/spacer icons
/// don't leak into the picture list. Query strings are ignored.
fn looks_like_photo(src: &str) -> bool {
    let path = src.split(['?', '#']).next().unwrap_or(src).to_ascii_lowercase();
    [".jpg", ".jpeg", ".png", ".gif", ".webp"].iter().any(|ext| path.ends_with(ext))
}

/// Resolve a DOFbasen image reference to an absolute URL. Root-relative and
/// scheme-relative hrefs are prefixed; already-absolute URLs pass through.
fn absolutize(href: &str) -> String {
    let h = href.trim();
    if h.starts_with("http://") || h.starts_with("https://") {
        h.to_string()
    } else if let Some(rest) = h.strip_prefix("//") {
        format!("https://{rest}")
    } else if h.starts_with('/') {
        format!("https://dofbasen.dk{h}")
    } else {
        format!("https://dofbasen.dk/{h}")
    }
}

fn text_of(el: ElementRef) -> String {
    el.text().collect::<String>().trim().to_string()
}

fn has_class(el: ElementRef, class: &str) -> bool {
    el.value()
        .attr("class")
        .is_some_and(|c| c.split_whitespace().any(|x| x == class))
}

/// Full observation parser. Returns observations without coord resolution
/// (the poplok/DB fill happens in the network-allowed refresher).
pub fn parse_observations(html: &str, _date_label: &str) -> Vec<Observation> {
    let tr_sel = Selector::parse("table tr").unwrap();
    let td_sel = Selector::parse("td").unwrap();
    let count_sel = Selector::parse(r#"td[align="right"] a.arter"#).unwrap();
    let lok_sel = Selector::parse("a.lokalitet").unwrap();
    let pos_sel = Selector::parse("a.position").unwrap();
    let right_a_sel = Selector::parse(r#"td[align="right"] a"#).unwrap();
    let arter_title_sel = Selector::parse("a.arter[title]").unwrap();
    let clock_sel = Selector::parse("i.fa-clock-o[title]").unwrap();
    // Note ("bemærkning") sits in the title of a comment icon, mirroring the
    // clock-icon convention above. `[class*="comment"]` covers fa-comment,
    // fa-comment-o and fa-commenting-o without pinning one variant.
    let note_sel = Selector::parse(r#"i[class*="comment"][title]"#).unwrap();
    // Picture anchors carry class="lightbox" with the image-proxy URL in the
    // href (current markup); a camera/picture icon child marks older markup.
    let anchor_sel = Selector::parse("a").unwrap();
    let photo_icon_sel = Selector::parse(r#"i[class*="camera"], i[class*="picture"]"#).unwrap();
    let img_sel = Selector::parse("img").unwrap();
    // Finer place detail (sub-site / exact spot) when DOFbasen supplies it.
    let place_sel = Selector::parse(r#"[class*="sted"], [class*="delomr"]"#).unwrap();

    let blocks: Vec<Block> = SPECIES_RE
        .captures_iter(html)
        .map(|c| Block {
            index: c.get(0).unwrap().start(),
            art_id: c[1].to_string(),
            css_class: c[3].to_string(),
            danish: c[4].trim().to_string(),
            latin: c[5].trim().to_string(),
        })
        .collect();

    let mut observations = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for i in 0..blocks.len() {
        let sp = &blocks[i];
        let start = sp.index;
        let end = if i + 1 < blocks.len() { blocks[i + 1].index } else { html.len() };
        let frag = Html::parse_fragment(&html[start..end]);

        for row in frag.select(&tr_sel) {
            if row.select(&td_sel).count() < 10 {
                continue;
            }

            let count = row
                .select(&count_sel)
                .next()
                .map(|e| parse_int_prefix(&text_of(e)))
                .unwrap_or(0);

            let (location, loknr) = match row.select(&lok_sel).next() {
                Some(l) => {
                    let onclick = l.value().attr("onclick").unwrap_or("");
                    let loknr = LOKNR_RE.captures(onclick).map(|c| c[1].to_string());
                    (text_of(l), loknr)
                }
                None => (String::new(), None),
            };

            let (mut lat, mut lng) = (None, None);
            if let Some(p) = row.select(&pos_sel).next() {
                let onclick = p.value().attr("onclick").unwrap_or("");
                if let Some(c) = POS_RE.captures(onclick) {
                    lng = parse_coord(&c[1]);
                    lat = parse_coord(&c[2]);
                }
            }

            // First right-aligned <a> that isn't arter/lokalitet, skipping
            // "Information om ..." links; take its non-empty text.
            let mut observer = String::new();
            for a in row.select(&right_a_sel) {
                if has_class(a, "arter") || has_class(a, "lokalitet") {
                    continue;
                }
                if a.value().attr("title").unwrap_or("").starts_with("Information om") {
                    continue;
                }
                let t = text_of(a);
                if !t.is_empty() && observer.is_empty() {
                    observer = t;
                }
            }

            // Last matching arter-title link wins (mirrors the JS `.each`).
            let mut behavior = String::new();
            for a in row.select(&arter_title_sel) {
                let title = a.value().attr("title").unwrap_or("");
                if !title.is_empty()
                    && !title.starts_with("Alle observationer")
                    && !title.starts_with("Mere information")
                {
                    behavior = title.to_string();
                }
            }

            let time = row
                .select(&clock_sel)
                .next()
                .and_then(|c| c.value().attr("title"))
                .map(|t| {
                    t.replace("Ophold på lokaliteten: ", "")
                        .replace("Ophold p\u{e5} lokaliteten: ", "")
                })
                .unwrap_or_default();

            // Free-text note from the comment icon's title.
            let note = row
                .select(&note_sel)
                .next()
                .and_then(|c| c.value().attr("title"))
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .unwrap_or_default();

            // Picture URLs: lightbox/photo-icon anchors, plus any inline
            // thumbnails. De-duplicated, order preserved.
            let mut pictures = Vec::new();
            for a in row.select(&anchor_sel) {
                if !has_class(a, "lightbox") && a.select(&photo_icon_sel).next().is_none() {
                    continue;
                }
                if let Some(href) = a.value().attr("href").filter(|h| !h.trim().is_empty()) {
                    let url = absolutize(href);
                    if !pictures.contains(&url) {
                        pictures.push(url);
                    }
                }
            }
            for img in row.select(&img_sel) {
                if let Some(src) = img.value().attr("src").filter(|s| looks_like_photo(s)) {
                    let url = absolutize(src);
                    if !pictures.contains(&url) {
                        pictures.push(url);
                    }
                }
            }

            // Finer place detail, when present.
            let place = row
                .select(&place_sel)
                .next()
                .map(text_of)
                .filter(|t| !t.is_empty());

            if location.is_empty() {
                continue;
            }
            let key = format!("{}-{}", sp.danish, location);
            if !seen.insert(key) {
                continue;
            }

            observations.push(Observation {
                species: sp.danish.clone(),
                latin: sp.latin.clone(),
                art_id: sp.art_id.clone(),
                count,
                location,
                loknr,
                lat,
                lng,
                observer,
                behavior,
                time,
                note,
                place,
                pictures,
                rare: sp.css_class == "su",
                scarce: sp.css_class == "subart",
                seasonal: sp.css_class == "seasonart",
            });
        }
    }

    observations
}

/// Fetch today's (GET) or a past date's (POST) observations page and parse it.
pub async fn fetch_observations(client: &reqwest::Client, date: Option<&str>) -> anyhow::Result<Vec<Observation>> {
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let effective = date.unwrap_or(&today);
    let is_today = date.is_none() || date == Some(today.as_str());

    let resp = if is_today {
        client.get("https://dofbasen.dk/observationer/").send().await?
    } else {
        client
            .post("https://dofbasen.dk/observationer/index.php")
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(format!("idag={}&summering=tur", effective))
            .send()
            .await?
    };
    if !resp.status().is_success() {
        anyhow::bail!("DOFbasen returned {}", resp.status().as_u16());
    }
    let bytes = resp.bytes().await?;
    Ok(parse_observations(&decode_latin1(&bytes), effective))
}

/// Resolve a locality's centre coords from DOFbasen's `poplok.php`. Mirrors the
/// fallback in `parseObservationsHtml` — including its lon/lat field swap.
pub async fn fetch_locality_coords(client: &reqwest::Client, loknr: &str) -> (Option<f64>, Option<f64>) {
    let url = format!("https://dofbasen.dk/poplok.php?loknr={loknr}");
    let Ok(resp) = client.get(&url).send().await else { return (None, None) };
    let Ok(bytes) = resp.bytes().await else { return (None, None) };
    let html = decode_latin1(&bytes);
    let doc = Html::parse_document(&html);
    let lon_sel = Selector::parse("#lok_center_lon").unwrap();
    let lat_sel = Selector::parse("#lok_center_lat").unwrap();
    let lon_val = doc.select(&lon_sel).next().and_then(|e| text_of(e).parse::<f64>().ok());
    let lat_val = doc.select(&lat_sel).next().and_then(|e| text_of(e).parse::<f64>().ok());
    // JS assigns lat = lon_val, lng = lat_val (the original swap). Preserved.
    (lon_val, lat_val)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SU (rarity) species are bracketed and carry a `(SU)` marker between the
    /// name link and the latin name; the delimiter regex must still capture
    /// them, else they never enter the DB or the "missing ticks" list.
    #[test]
    fn species_re_matches_su_species() {
        let su = r#"[<a class="arter" href="/search/search1.php?soeg=soeg&art=02550&visning=allfugle" title="Alle observationer af Munkegrib i 2026"><span class="su">Munkegrib</span></a>] (SU) (<i>Aegypius monachus</i>):"#;
        let c = SPECIES_RE.captures(su).expect("SU species block should match");
        assert_eq!(&c[1], "02550");
        assert_eq!(&c[3], "su");
        assert_eq!(&c[4], "Munkegrib");
        assert_eq!(&c[5], "Aegypius monachus");

        // Ordinary species (no bracket, no marker) must still match.
        let normal = r#"<a class="arter" href="/search/search1.php?art=02130" title="Alle observationer af Sortand i 2026"><span class="defaultart">Sortand</span></a> (<i>Melanitta nigra</i>):"#;
        let c = SPECIES_RE.captures(normal).expect("ordinary species block should match");
        assert_eq!(&c[3], "defaultart");
        assert_eq!(&c[4], "Sortand");
        assert_eq!(&c[5], "Melanitta nigra");
    }

    /// An observation carrying a note, a photo and a place detail must surface
    /// all three, while the pre-existing fields keep parsing unchanged.
    #[test]
    fn parses_note_picture_and_place() {
        let html = r##"
<a class="arter" href="/search/search1.php?art=02130" title="Alle observationer af Sortand i 2026"><span class="defaultart">Sortand</span></a> (<i>Melanitta nigra</i>):
<table>
  <tr>
    <td align="right"><a class="arter" href="/search/search1.php?art=02130" title="Rastende">12</a></td>
    <td><a class="lokalitet" onclick="visLok('loknr=1234')">Blåvand</a></td>
    <td><span class="sted">Fyrhaven</span></td>
    <td><a class="position" onclick="visKort('lng=8,08&lat=55,55')"><i class="fa fa-map-marker"></i></a></td>
    <td><i class="fa fa-clock-o" title="Ophold på lokaliteten: 08:15-09:00"></i></td>
    <td><i class="fa fa-comment-o" title="Trækkende mod syd, adult han"></i></td>
    <td><a class="lightbox" rel="40024940" href='/image_proxy.php?mode=o&amp;pic=40024940_20260816053052_775068687.jpg' title="Sortand, 16/08/2026. Foto/copyright: Ole Ventzel"><i class="fa fa-picture-o blue"></i></a><a class="lightbox" rel="40024940" href='/image_proxy.php?mode=o&amp;pic=40024940_20260816053106_183796749.jpg' title="Sortand, 16/08/2026. Foto/copyright: Ole Ventzel"><i class="fa fa-picture-o blue"></i></a></td>
    <td><a href="#" title="Information om observatøren"></a></td>
    <td align="right"><a href="/observatoer.php?id=42">Ole Ventzel</a></td>
    <td>&nbsp;</td>
  </tr>
</table>
"##;
        let obs = parse_observations(html, "fixture");
        assert_eq!(obs.len(), 1, "one observation expected");
        let o = &obs[0];
        assert_eq!(o.species, "Sortand");
        assert_eq!(o.count, 12);
        assert_eq!(o.location, "Blåvand");
        assert_eq!(o.observer, "Ole Ventzel");
        assert_eq!(o.note, "Trækkende mod syd, adult han");
        assert_eq!(o.place.as_deref(), Some("Fyrhaven"));
        assert_eq!(
            o.pictures,
            vec![
                "https://dofbasen.dk/image_proxy.php?mode=o&pic=40024940_20260816053052_775068687.jpg",
                "https://dofbasen.dk/image_proxy.php?mode=o&pic=40024940_20260816053106_183796749.jpg",
            ]
        );
    }

    /// Observations without the new detail fields must still parse cleanly with
    /// empty defaults — no behaviour change for the common case.
    #[test]
    fn parses_observation_without_details() {
        let html = r#"
<a class="arter" href="/search/search1.php?art=02130" title="Alle observationer af Sortand i 2026"><span class="defaultart">Sortand</span></a> (<i>Melanitta nigra</i>):
<table>
  <tr>
    <td align="right"><a class="arter" href="/search/search1.php?art=02130" title="Rastende">3</a></td>
    <td><a class="lokalitet" onclick="visLok('loknr=1234')">Blåvand</a></td>
    <td>&nbsp;</td>
    <td><i class="fa fa-clock-o" title="Ophold på lokaliteten: 10:00"></i></td>
    <td>&nbsp;</td>
    <td>&nbsp;</td>
    <td>&nbsp;</td>
    <td>&nbsp;</td>
    <td align="right"><a href="/observatoer.php?id=42">Ole Ventzel</a></td>
    <td>&nbsp;</td>
  </tr>
</table>
"#;
        let obs = parse_observations(html, "fixture");
        assert_eq!(obs.len(), 1);
        let o = &obs[0];
        assert_eq!(o.note, "");
        assert_eq!(o.place, None);
        assert!(o.pictures.is_empty());
    }

    /// Fixture-driven parity dump: set BIRD_OBS_FIXTURE (raw ISO-8859-1 bytes)
    /// and BIRD_OBS_OUT to write parsed observations as JSON for comparison
    /// against the Node parser. No-op when env is unset.
    #[test]
    fn dump_observations_fixture() {
        let (Ok(path), Ok(out)) = (std::env::var("BIRD_OBS_FIXTURE"), std::env::var("BIRD_OBS_OUT")) else {
            return;
        };
        let bytes = std::fs::read(&path).expect("read fixture");
        let obs = parse_observations(&decode_latin1(&bytes), "fixture");
        std::fs::write(&out, serde_json::to_string(&obs).unwrap()).expect("write out");
        eprintln!("wrote {} observations to {out}", obs.len());
    }
}
