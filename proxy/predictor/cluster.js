const CLUSTER_RADIUS_KM = 40;

function distanceKm(lat1, lng1, lat2, lng2) {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return null;
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function clusterByRadius(candidates, radiusKm = CLUSTER_RADIUS_KM) {
  const sorted = [...candidates].sort((a, b) => (b.score || 0) - (a.score || 0));
  const clusters = [];

  for (const cand of sorted) {
    if (cand.lat == null || cand.lng == null) {
      clusters.push(makeCluster(cand));
      continue;
    }

    let target = null;
    let targetDist = Infinity;
    for (const c of clusters) {
      if (c.centroidLat == null) continue;
      const d = distanceKm(cand.lat, cand.lng, c.centroidLat, c.centroidLng);
      if (d != null && d <= radiusKm && d < targetDist) {
        target = c;
        targetDist = d;
      }
    }

    if (target) {
      target.members.push({ ...cand, distKmFromCentroid: targetDist });
      const totalScore = target.scoreSum + (cand.score || 0);
      if (totalScore > 0) {
        target.centroidLat =
          (target.centroidLat * target.scoreSum + cand.lat * (cand.score || 0)) / totalScore;
        target.centroidLng =
          (target.centroidLng * target.scoreSum + cand.lng * (cand.score || 0)) / totalScore;
      }
      target.scoreSum = totalScore;
    } else {
      clusters.push(makeCluster(cand));
    }
  }

  return clusters.map(finalizeCluster);
}

function makeCluster(cand) {
  return {
    centroidLat: cand.lat,
    centroidLng: cand.lng,
    scoreSum: cand.score || 0,
    members: [{ ...cand, distKmFromCentroid: 0 }],
  };
}

function finalizeCluster(c) {
  const members = [...c.members].sort((a, b) => (b.score || 0) - (a.score || 0));
  const top = members[0];
  const nearby = members.slice(1).map((m) => ({
    location: m.location,
    loknr: m.loknr,
    distKm: m.distKmFromCentroid == null ? null : Math.round(m.distKmFromCentroid * 10) / 10,
    score: m.score,
  }));
  return {
    name: top.location,
    loknr: top.loknr,
    centroidLat: c.centroidLat,
    centroidLng: c.centroidLng,
    score: c.scoreSum,
    topMemberScore: top.score,
    members,
    nearby,
  };
}

module.exports = { clusterByRadius, distanceKm, CLUSTER_RADIUS_KM };
