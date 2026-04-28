"use client";

import { motion } from "framer-motion";

const FEATURES = [
  {
    id: "search",
    number: "01",
    title: "Search-First Investigation",
    description:
      "Type a query. Resolve entities, regions, and signals. Get a grounded investigation state with evidence-backed summaries, not a pretty dashboard.",
    tags: ["Entity Resolution", "Hybrid Search", "Query Parsing"],
  },
  {
    id: "evidence",
    number: "02",
    title: "Grounded Evidence Engine",
    description:
      "Every claim is backed by timestamped sources with freshness and relevance metadata. Confidence scores are derived, not asserted.",
    tags: ["Source Ranking", "Confidence Scoring", "Freshness Tracking"],
  },
  {
    id: "dependency",
    number: "03",
    title: "Dependency Path Tracing",
    description:
      "Map likely downstream effects with ranked edges and evidence-linked rationale. Understand exposure before it materializes.",
    tags: ["Graph Reasoning", "Impact Ranking", "Edge Rationale"],
  },
] as const;

export function FeaturesSection() {
  return (
    <section className="features" id="features" data-phase="features">
      <motion.div
        className="features__header"
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
      >
        <span className="features__eyebrow">Platform Capabilities</span>
        <h2 className="features__title">
          Built for analysts,
          <br />
          not audiences.
        </h2>
      </motion.div>

      <div className="features__grid">
        {FEATURES.map((feature, index) => (
          <motion.article
            key={feature.id}
            className="feature-card"
            initial={{ opacity: 0, y: 40 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{
              duration: 0.7,
              delay: index * 0.15,
              ease: [0.22, 1, 0.36, 1],
            }}
          >
            <span className="feature-card__number">{feature.number}</span>
            <h3 className="feature-card__title">{feature.title}</h3>
            <p className="feature-card__description">{feature.description}</p>
            <div className="feature-card__tags">
              {feature.tags.map((tag) => (
                <span key={tag} className="feature-card__tag">
                  {tag}
                </span>
              ))}
            </div>
          </motion.article>
        ))}
      </div>
    </section>
  );
}
