//! Netfugl ticklist scraping — port of the network branch of
//! `fetchTickListData` in `proxy/server.js`. Netfugl pages are UTF-8.

use std::sync::LazyLock;

use regex::Regex;
use scraper::{ElementRef, Html, Selector};

use super::Bird;

static PAREN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\(([^)]+)\)").unwrap());

fn text_of(el: ElementRef) -> String {
    el.text().collect::<String>().trim().to_string()
}

/// Parse the ranking table into ticklist entries. Latin name is the
/// parenthesised part of the name cell; `name` is the rest.
pub fn parse_ticklist(html: &str) -> Vec<Bird> {
    let doc = Html::parse_document(html);
    let row_sel = Selector::parse("table.datatable tbody tr").unwrap();
    let td_sel = Selector::parse("td").unwrap();

    let mut birds = Vec::new();
    for row in doc.select(&row_sel) {
        let cells: Vec<ElementRef> = row.select(&td_sel).collect();
        if cells.len() < 4 {
            continue;
        }
        let ticked = text_of(cells[1]) == "X";
        let is_su = text_of(cells[2]) == "*";
        let name_cell = text_of(cells[3]);
        let latin = PAREN_RE
            .captures(&name_cell)
            .map(|c| c[1].trim().to_string())
            .unwrap_or_default();
        let name = PAREN_RE.replace(&name_cell, "").trim().to_string();
        if !name.is_empty() {
            birds.push(Bird { name, latin, ticked, is_su });
        }
    }
    birds
}

/// Fetch + parse a user's ticklist. `Ok(None)` = not found / empty (mirrors the
/// JS `return null`); `Ok(Some(vec![]))` = the Netfugl "user not found" page.
pub async fn fetch_ticklist(
    client: &reqwest::Client,
    user_id: &str,
    list_type: &str,
) -> anyhow::Result<Option<Vec<Bird>>> {
    let url = format!("https://netfugl.dk/ranking/{list_type}/{user_id}");
    let resp = client.get(&url).send().await?;
    if !resp.status().is_success() {
        return Ok(None);
    }
    let html = resp.text().await?;

    {
        let doc = Html::parse_document(&html);
        let p_sel = Selector::parse("p").unwrap();
        let p_text: String = doc.select(&p_sel).flat_map(|p| p.text()).collect();
        if p_text.contains("Klik her for at vende tilbage") {
            return Ok(Some(vec![]));
        }
    }

    let birds = parse_ticklist(&html);
    if birds.is_empty() {
        return Ok(None);
    }
    Ok(Some(birds))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Set BIRD_TICK_FIXTURE (UTF-8 HTML) + BIRD_TICK_OUT to dump parsed birds
    /// as JSON for comparison against the Node parser. No-op when env is unset.
    #[test]
    fn dump_ticklist_fixture() {
        let (Ok(path), Ok(out)) = (std::env::var("BIRD_TICK_FIXTURE"), std::env::var("BIRD_TICK_OUT")) else {
            return;
        };
        let html = std::fs::read_to_string(&path).expect("read fixture");
        let birds = parse_ticklist(&html);
        std::fs::write(&out, serde_json::to_string(&birds).unwrap()).expect("write out");
        eprintln!("wrote {} birds to {out}", birds.len());
    }
}
