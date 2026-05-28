const stats = require("./stats");
const { clusterByRadius, CLUSTER_RADIUS_KM } = require("./cluster");
const { performance } = require("perf_hooks");

const DAY_OUTPUT_LIMIT = 15;
const CALENDAR_OUTPUT_LIMIT = 10;
const MAX_SPECIES_PER_CLUSTER = 8;

function normaliseScores(items) {
  if (!items.length) return items;
  const max = items.reduce((m, x) => Math.max(m, x.score), 0) || 1;
  return items.map((x) => ({ ...x, scoreNorm: x.score / max }));
}

function bandFromScore(scoreNorm) {
  if (scoreNorm >= 0.7) return "høj";
  if (scoreNorm >= 0.4) return "mellem";
  return "lav";
}

async function rankForDay({ lat, lng, missingBirds, today = new Date(), timings = null }) {
  const missingLatins = missingBirds.map((b) => b.latin).filter(Boolean);
  if (!missingLatins.length) return { items: [] };

  const tStats = performance.now();
  let candidates = await stats.rankCandidatesForDay({
    lat,
    lng,
    missingLatins,
    today,
    timings,
  });
  if (timings) timings.stats = Math.round(performance.now() - tStats);
  if (!candidates.length) return { items: [] };

  const tCluster = performance.now();
  const bySpecies = new Map();
  for (const c of candidates) {
    const key = c.latin.toLowerCase();
    if (!bySpecies.has(key)) bySpecies.set(key, []);
    bySpecies.get(key).push(c);
  }

  const speciesItems = [];
  for (const [, perSpecies] of bySpecies) {
    const clusters = clusterByRadius(perSpecies, CLUSTER_RADIUS_KM);
    if (!clusters.length) continue;
    const best = clusters.sort((a, b) => b.score - a.score)[0];
    const allEvidence = [];
    for (const m of best.members) {
      if (m.evidence) allEvidence.push(...m.evidence);
    }
    allEvidence.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    speciesItems.push({
      latin: perSpecies[0].latin,
      species: perSpecies[0].species,
      cluster: {
        name: best.name,
        loknr: best.loknr,
        centroidLat: best.centroidLat,
        centroidLng: best.centroidLng,
        nearby: best.nearby.slice(0, 5),
      },
      score: best.score,
      evidence: allEvidence,
      memberLoknrs: best.members.map((m) => m.loknr).filter(Boolean),
    });
  }

  const normalised = normaliseScores(
    speciesItems.sort((a, b) => b.score - a.score)
  ).slice(0, DAY_OUTPUT_LIMIT);

  if (timings) timings.cluster = Math.round(performance.now() - tCluster);

  return {
    items: normalised.map((it) => ({ ...it, band: bandFromScore(it.scoreNorm) })),
  };
}

async function rankForCalendar({ month, missingBirds }) {
  const missingLatins = missingBirds.map((b) => b.latin).filter(Boolean);
  if (!missingLatins.length) return { items: [] };

  const candidates = await stats.rankCandidatesForCalendar({
    month,
    missingLatins,
  });
  if (!candidates.length) return { items: [] };

  const clusters = clusterByRadius(candidates, CLUSTER_RADIUS_KM);
  if (!clusters.length) return { items: [] };

  const items = clusters.map((cl) => {
    const bySpecies = new Map();
    for (const m of cl.members) {
      const key = m.latin.toLowerCase();
      if (!bySpecies.has(key) || bySpecies.get(key).score < m.score) {
        bySpecies.set(key, m);
      }
    }
    const speciesList = [...bySpecies.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SPECIES_PER_CLUSTER);

    const allEvidenceByLatin = new Map();
    for (const s of speciesList) {
      const samples = [];
      for (const m of cl.members) {
        if (m.latin.toLowerCase() === s.latin.toLowerCase() && m.evidence) {
          samples.push(...m.evidence);
        }
      }
      samples.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      allEvidenceByLatin.set(s.latin.toLowerCase(), samples);
    }

    return {
      cluster: {
        name: cl.name,
        loknr: cl.loknr,
        centroidLat: cl.centroidLat,
        centroidLng: cl.centroidLng,
        nearby: cl.nearby.slice(0, 6),
      },
      score: cl.score,
      species: speciesList.map((s) => ({
        latin: s.latin,
        species: s.species,
        score: s.score,
        evidence: allEvidenceByLatin.get(s.latin.toLowerCase()) || [],
      })),
    };
  });

  items.sort((a, b) => {
    if (b.species.length !== a.species.length) return b.species.length - a.species.length;
    return b.score - a.score;
  });

  const top = items.slice(0, CALENDAR_OUTPUT_LIMIT);
  const speciesMax = top.reduce(
    (m, it) => Math.max(m, ...it.species.map((s) => s.score)),
    0
  ) || 1;
  for (const it of top) {
    for (const s of it.species) {
      s.scoreNorm = s.score / speciesMax;
      s.band = bandFromScore(s.scoreNorm);
    }
  }

  return { items: top };
}

module.exports = { rankForDay, rankForCalendar };
