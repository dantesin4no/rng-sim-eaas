/**
 * 3-link pendulum in absolute angles. Lagrangian equations of motion:
 *   M(theta) thetadd = f(theta, thetad)
 * with M[i][j] = c(max(i,j)) * l_i * l_j * cos(th_i - th_j),
 *      c(k) = sum of masses from link k outward.
 * Integrated with classical RK4.
 *
 * State layout: [th1, th2, th3, w1, w2, w3]
 */

export const G = 9.81;

export function makePendulum({ masses = [1, 1, 1], lengths = [1, 0.9, 0.8] } = {}) {
  const n = 3;
  const m = masses.slice(0, n);
  const l = lengths.slice(0, n);

  const csum = (k) => {
    let s = 0;
    for (let i = k; i < n; i++) s += m[i];
    return s;
  };

  function solve3(A, b) {
    const M = [
      [A[0][0], A[0][1], A[0][2], b[0]],
      [A[1][0], A[1][1], A[1][2], b[1]],
      [A[2][0], A[2][1], A[2][2], b[2]],
    ];
    for (let c = 0; c < 3; c++) {
      let p = c;
      for (let r = c + 1; r < 3; r++)
        if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (p !== c) [M[c], M[p]] = [M[p], M[c]];
      const piv = M[c][c] || 1e-12;
      for (let r = 0; r < 3; r++) {
        if (r === c) continue;
        const f = M[r][c] / piv;
        for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
      }
    }
    return [
      M[0][3] / (M[0][0] || 1e-12),
      M[1][3] / (M[1][1] || 1e-12),
      M[2][3] / (M[2][2] || 1e-12),
    ];
  }

  function massMatrix(th) {
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        A[i][j] = csum(Math.max(i, j)) * l[i] * l[j] * Math.cos(th[i] - th[j]);
    return A;
  }

  function derivs(s) {
    const th = [s[0], s[1], s[2]];
    const w = [s[3], s[4], s[5]];
    const A = massMatrix(th);
    const b = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      let acc = 0;
      for (let j = 0; j < 3; j++)
        acc -=
          csum(Math.max(i, j)) * l[i] * l[j] * Math.sin(th[i] - th[j]) * w[j] * w[j];
      acc -= G * l[i] * csum(i) * Math.sin(th[i]);
      b[i] = acc;
    }
    const a = solve3(A, b);
    return [w[0], w[1], w[2], a[0], a[1], a[2]];
  }

  function rk4Step(s, dt) {
    const k1 = derivs(s);
    const s2 = s.map((v, i) => v + (dt / 2) * k1[i]);
    const k2 = derivs(s2);
    const s3 = s.map((v, i) => v + (dt / 2) * k2[i]);
    const k3 = derivs(s3);
    const s4 = s.map((v, i) => v + dt * k3[i]);
    const k4 = derivs(s4);
    return s.map((v, i) => v + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
  }

  /** Total mechanical energy — the conservation invariant tests rely on. */
  function energy(s) {
    const th = [s[0], s[1], s[2]];
    const w = [s[3], s[4], s[5]];
    let T = 0;
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        T +=
          0.5 *
          csum(Math.max(i, j)) *
          l[i] *
          l[j] *
          Math.cos(th[i] - th[j]) *
          w[i] *
          w[j];
    let V = 0;
    for (let i = 0; i < 3; i++) V -= G * csum(i) * l[i] * Math.cos(th[i]);
    return T + V;
  }

  return { derivs, rk4Step, energy, massMatrix, masses: m, lengths: l };
}
