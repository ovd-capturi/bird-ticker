//! DOFbasen observation scraping — port of `parseObservationsHtml` and the
//! lighter `fetchObsData` from `proxy/server.js`.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;
use scraper::{ElementRef, Html, Selector};

use super::Observation;

/// Species-block delimiter. Groups: 1=artId, 2=fullTitle, 3=cssClass,
/// 4=danishName, 5=latinName. Identical to the JS regex.
static SPECIES_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"<a[^>]*class="arter"[^>]*href="[^"]*art=(\d+)[^"]*"[^>]*title="Alle observationer af ([^"]+)"[^>]*><span class="(defaultart|subart|su|seasonart)">([^<]+)</span></a>\s*\(<i>([^<]+)</i>\):"#,
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
