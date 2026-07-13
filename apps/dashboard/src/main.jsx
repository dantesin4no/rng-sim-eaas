import React from "react";
import ReactDOM from "react-dom/client";
import TriplePendulumRNG from "./TriplePendulumRNG.jsx";

// Note: StrictMode intentionally omitted — its dev-mode double-mount would
// briefly run two physics/harvest loops before cleanup. Harmless, but noisy
// for an entropy demo where source counters should be exact.
ReactDOM.createRoot(document.getElementById("root")).render(
  <TriplePendulumRNG />
);
