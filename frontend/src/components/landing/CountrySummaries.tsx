"use client";

import { motion } from "framer-motion";

interface CountryData {
  iso3: string;
  name: string;
  region: string;
  riskLevel: "critical" | "elevated" | "watch" | "stable";
  score: number;
  delta: number;
  activeSignals: number;
  topDriver: string;
}

const COUNTRIES: CountryData[] = [
  {
    iso3: "YEM",
    name: "Yemen",
    region: "Middle East",
    riskLevel: "critical",
    score: 92,
    delta: +14,
    activeSignals: 28,
    topDriver: "Houthi maritime disruption in Red Sea",
  },
  {
    iso3: "UKR",
    name: "Ukraine",
    region: "Eastern Europe",
    riskLevel: "critical",
    score: 88,
    delta: +3,
    activeSignals: 41,
    topDriver: "Active conflict, infrastructure degradation",
  },
  {
    iso3: "TWN",
    name: "Taiwan",
    region: "East Asia",
    riskLevel: "elevated",
    score: 71,
    delta: +6,
    activeSignals: 15,
    topDriver: "Strait transit pressure, chip supply risk",
  },
  {
    iso3: "IRN",
    name: "Iran",
    region: "Middle East",
    riskLevel: "elevated",
    score: 74,
    delta: -2,
    activeSignals: 19,
    topDriver: "Strait of Hormuz chokepoint leverage",
  },
  {
    iso3: "PAN",
    name: "Panama",
    region: "Central America",
    riskLevel: "watch",
    score: 58,
    delta: -5,
    activeSignals: 8,
    topDriver: "Canal drought, transit capacity reduction",
  },
  {
    iso3: "SDN",
    name: "Sudan",
    region: "East Africa",
    riskLevel: "critical",
    score: 85,
    delta: +7,
    activeSignals: 22,
    topDriver: "Civil conflict, humanitarian corridor disruption",
  },
];

const LEVEL_COLORS: Record<CountryData["riskLevel"], string> = {
  critical: "var(--ds-danger)",
  elevated: "var(--ds-warning)",
  watch: "var(--ds-accent)",
  stable: "var(--ds-success)",
};

const LEVEL_LABELS: Record<CountryData["riskLevel"], string> = {
  critical: "Critical",
  elevated: "Elevated",
  watch: "Watch",
  stable: "Stable",
};

export function CountrySummaries() {
  return (
    <section className="countries" id="regions" data-phase="countries">
      <motion.div
        className="countries__header"
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
      >
        <span className="countries__eyebrow">Active Monitoring</span>
        <h2 className="countries__title">Regional risk at a glance</h2>
      </motion.div>

      <div className="countries__grid">
        {COUNTRIES.map((country, index) => (
          <motion.article
            key={country.iso3}
            className="country-card"
            data-risk={country.riskLevel}
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{
              duration: 0.6,
              delay: index * 0.1,
              ease: [0.22, 1, 0.36, 1],
            }}
          >
            <div className="country-card__top">
              <div>
                <span className="country-card__region">{country.region}</span>
                <h3 className="country-card__name">{country.name}</h3>
              </div>
              <div
                className="country-card__score"
                style={{ borderColor: LEVEL_COLORS[country.riskLevel] }}
              >
                {country.score}
              </div>
            </div>

            <div className="country-card__level">
              <span
                className="country-card__dot"
                style={{ background: LEVEL_COLORS[country.riskLevel] }}
              />
              <span style={{ color: LEVEL_COLORS[country.riskLevel] }}>
                {LEVEL_LABELS[country.riskLevel]}
              </span>
              <span className="country-card__delta" data-positive={country.delta > 0}>
                {country.delta > 0 ? "+" : ""}
                {country.delta}
              </span>
            </div>

            <p className="country-card__driver">{country.topDriver}</p>

            <div className="country-card__footer">
              <span>{country.activeSignals} active signals</span>
              <span className="country-card__iso">{country.iso3}</span>
            </div>
          </motion.article>
        ))}
      </div>
    </section>
  );
}
