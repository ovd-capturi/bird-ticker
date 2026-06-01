//! Web scraping — ports of the DOFbasen + Netfugl parsers in `proxy/server.js`.
//!
//! These feed the background notification poller and the backfill seeder; they
//! are never hit directly by a user request. DOFbasen pages are ISO-8859-1.

pub mod dofbasen;
pub mod netfugl;

/// One parsed DOFbasen observation. Field names/order mirror the object literal
/// in `parseObservationsHtml` so the JSON stored in `observations.raw` matches.
/// Note: the JS key is the American spelling `behavior` (the `behaviour` DB
/// column is populated separately and ends up null — preserved deliberately).
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct Observation {
    pub species: String,
    pub latin: String,
    #[serde(rename = "artId")]
    pub art_id: String,
    pub count: i32,
    pub location: String,
    pub loknr: Option<String>,
    pub lat: Option<f64>,
    pub lng: Option<f64>,
    pub observer: String,
    pub behavior: String,
    pub time: String,
    pub rare: bool,
    pub scarce: bool,
    pub seasonal: bool,
}

/// Lighter shape from the notification-only `fetchObsData` scraper.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct LightObs {
    pub species: String,
    pub latin: String,
    pub location: String,
    pub count: i32,
    pub time: String,
    pub rare: bool,
    pub scarce: bool,
}

/// A Netfugl ticklist entry. JSON keys match the array stored in `ticklists`.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct Bird {
    pub name: String,
    pub latin: String,
    pub ticked: bool,
    #[serde(rename = "isSU")]
    pub is_su: bool,
}
