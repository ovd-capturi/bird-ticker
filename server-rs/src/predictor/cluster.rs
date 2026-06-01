//! Greedy radius clustering — port of `proxy/predictor/cluster.js`.
//!
//! Candidates are processed in descending score order; each is folded into the
//! nearest existing cluster within `CLUSTER_RADIUS_KM`, otherwise it seeds a
//! new one. Centroids are score-weighted means.

use super::Scored;

pub const CLUSTER_RADIUS_KM: f64 = 40.0;

pub fn distance_km(lat1: f64, lng1: f64, lat2: f64, lng2: f64) -> f64 {
    let r = 6371.0_f64;
    let to_rad = |d: f64| d * std::f64::consts::PI / 180.0;
    let d_lat = to_rad(lat2 - lat1);
    let d_lng = to_rad(lng2 - lng1);
    let a = (d_lat / 2.0).sin().powi(2)
        + to_rad(lat1).cos() * to_rad(lat2).cos() * (d_lng / 2.0).sin().powi(2);
    r * 2.0 * a.sqrt().atan2((1.0 - a).sqrt())
}

#[derive(Clone)]
pub struct Member {
    pub cand: Scored,
    pub dist_km_from_centroid: Option<f64>,
}

pub struct NearbyItem {
    pub location: Option<String>,
    pub loknr: Option<String>,
    pub dist_km: Option<f64>,
    pub score: f64,
}

pub struct Cluster {
    pub name: Option<String>,
    pub loknr: Option<String>,
    pub centroid_lat: Option<f64>,
    pub centroid_lng: Option<f64>,
    pub score: f64,
    pub members: Vec<Member>,
    pub nearby: Vec<NearbyItem>,
}

struct Building {
    centroid_lat: Option<f64>,
    centroid_lng: Option<f64>,
    score_sum: f64,
    members: Vec<Member>,
}

/// Cluster candidates within `radius_km`. Mirrors `clusterByRadius`.
pub fn cluster_by_radius(candidates: &[Scored], radius_km: f64) -> Vec<Cluster> {
    let mut sorted: Vec<Scored> = candidates.to_vec();
    sorted.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    let mut clusters: Vec<Building> = Vec::new();

    for cand in sorted {
        let (Some(clat), Some(clng)) = (cand.lat, cand.lng) else {
            clusters.push(make_cluster(cand));
            continue;
        };

        let mut target: Option<usize> = None;
        let mut target_dist = f64::INFINITY;
        for (i, c) in clusters.iter().enumerate() {
            let (Some(ccl), Some(ccg)) = (c.centroid_lat, c.centroid_lng) else { continue };
            let d = distance_km(clat, clng, ccl, ccg);
            if d <= radius_km && d < target_dist {
                target = Some(i);
                target_dist = d;
            }
        }

        match target {
            Some(i) => {
                let c = &mut clusters[i];
                c.members.push(Member { cand: cand.clone(), dist_km_from_centroid: Some(target_dist) });
                let total = c.score_sum + cand.score;
                if total > 0.0 {
                    c.centroid_lat = Some((c.centroid_lat.unwrap() * c.score_sum + clat * cand.score) / total);
                    c.centroid_lng = Some((c.centroid_lng.unwrap() * c.score_sum + clng * cand.score) / total);
                }
                c.score_sum = total;
            }
            None => clusters.push(make_cluster(cand)),
        }
    }

    clusters.into_iter().map(finalize_cluster).collect()
}

fn make_cluster(cand: Scored) -> Building {
    Building {
        centroid_lat: cand.lat,
        centroid_lng: cand.lng,
        score_sum: cand.score,
        members: vec![Member { cand, dist_km_from_centroid: Some(0.0) }],
    }
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

fn finalize_cluster(c: Building) -> Cluster {
    let mut members = c.members;
    members.sort_by(|a, b| b.cand.score.partial_cmp(&a.cand.score).unwrap_or(std::cmp::Ordering::Equal));
    let top = members[0].cand.clone();
    let nearby = members
        .iter()
        .skip(1)
        .map(|m| NearbyItem {
            location: m.cand.location.clone(),
            loknr: m.cand.loknr.clone(),
            dist_km: m.dist_km_from_centroid.map(round1),
            score: m.cand.score,
        })
        .collect();
    Cluster {
        name: top.location,
        loknr: top.loknr,
        centroid_lat: c.centroid_lat,
        centroid_lng: c.centroid_lng,
        score: c.score_sum,
        members,
        nearby,
    }
}
