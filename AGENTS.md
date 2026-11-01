# Engineering rules

- Keep frontal filter regressions beside the shared BandpassFilter tests, using independent transfer-response references and actual coefficients; this verifies the filter used by the frontal path without duplicating production DSP or introducing camera test signals into the app.