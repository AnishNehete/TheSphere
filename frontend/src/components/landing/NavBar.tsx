"use client";

import { motion } from "framer-motion";

interface NavBarProps {
  onLaunch: () => void;
}

export function NavBar({ onLaunch }: NavBarProps) {
  return (
    <motion.nav
      className="nav-bar"
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.8, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="nav-bar__logo">
        <div className="nav-bar__logo-mark" />
        <span>SPHERE</span>
      </div>

      <div className="nav-bar__links">
        <a href="#features">Capabilities</a>
        <a href="#regions">Regions</a>
        <a href="#architecture">Architecture</a>
      </div>

      <button type="button" className="nav-bar__cta" onClick={onLaunch}>
        Launch Investigation
      </button>
    </motion.nav>
  );
}
