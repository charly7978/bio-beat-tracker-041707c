/**
 * MEDICAL AND PHYSIOLOGICAL THRESHOLDS (Single Source of Truth)
 * 
 * Basado en estándares de la AHA (American Heart Association) 
 * y literatura de procesamiento de señales PPG.
 */

export const VITAL_THRESHOLDS = {
  // HEART RATE (BPM)
  HR: {
    MIN: 30,
    MAX: 220,
    PHYSIOLOGICAL_RR_MIN_MS: 270,
    PHYSIOLOGICAL_RR_MAX_MS: 2200,
  },
  
  // BLOOD OXYGEN (SpO2) — modelo ratio-of-ratios cámara+flash (verde como proxy IR)
  SPO2: {
    MIN_VALID: 75,
    MAX_VALID: 100,
    CRITICAL_LOW: 90,
    R_VALUE_MIN: 0.1,
    R_VALUE_MAX: 2.5,
    /** SpO2 = intercept − slope × R_mediana (calibración smartphone) */
    R_MODEL_INTERCEPT: 103,
    R_MODEL_SLOPE: 11,
    /** Coeficientes del modelo cuadrático mejorado */
    R_MODEL_A: -3.5,
    R_MODEL_B: -7.5,
    R_MODEL_C: 104,
    DISPLAY_CAP: 100,
    R_HISTORY_SAMPLES: 15,
    MIN_PI_PERCENT: 0.02,
    MIN_RED_DC: 10,
    MIN_GREEN_DC: 5,
  },
  
  /** Geometría dedo: unificar punta (HR/SpO2) y almohadilla (PA) */
  PLACEMENT: {
    PAD_COVERAGE_MIN: 0.17,
    PAD_CV_MAX: 0.048,
    TIP_COVERAGE_MAX: 0.16,
    TIP_CV_MIN: 0.034,
    TIP_PI_MIN: 0.00045,
    BP_CYCLE_QUALITY_TIP: 0.24,
    BP_CYCLE_QUALITY_PAD: 0.28,
    BP_CYCLE_QUALITY_HYBRID: 0.26,
  },

  // BLOOD PRESSURE — rangos fisiológicos (AHA / supervivencia) + normalización morfológica PPG
  BP: {
    SYSTOLIC_MIN: 20,
    SYSTOLIC_MAX: 280,
    DIASTOLIC_MIN: 40,
    DIASTOLIC_MAX: 130,
    MAP_MIN: 50,
    MAP_MAX: 150,
    PP_MIN: 15,
    PP_MAX: 110,
    DIA_SYS_RATIO_MIN: 0.30,
    DIA_SYS_RATIO_MAX: 0.90,
    /** Fracción de PP atribuible a reflexión de onda (índice 0–1) */
    REFLECTION_PP_FRAC: 0.22,
    MIN_CYCLES: 2,
    MIN_CYCLE_QUALITY: 0.28,
    MIN_BUFFER_SAMPLES: 90,
    STABILITY_FRAMES_HIGH: 20,
    STABILITY_FRAMES_MEDIUM: 12,
    FEATURE_QUALITY_HIGH: 72,
    FEATURE_QUALITY_MEDIUM: 36,
    MIN_RR_CONFIDENCE: 0.08,
    /** Límites de forma de pulso (adimensional / ms) — no mmHg */
    FEATURE_NORM: {
      K_VALUE: [0.22, 0.58] as const,
      AREA_RATIO: [0.65, 2.5] as const,
      DECAY_LAMBDA: [0.0004, 0.006] as const,
      B_DIV_A: [-1.2, 1.4] as const,
      D_DIV_A: [-1.0, 0.85] as const,
      AGI: [-0.9, 2.2] as const,
      STIFFNESS_INDEX: [0.5, 24] as const,
      AUGMENTATION_INDEX: [3, 42] as const,
      V_MAX: [15, 120] as const,
      SUT_CYCLE_RATIO: [0.05, 0.42] as const,
      DIA_PHASE_RATIO: [0.15, 0.82] as const,
      PW50_CYCLE_RATIO: [0.1, 0.58] as const,
      DICROTIC_DEPTH: [0.05, 0.55] as const,
      RMSSD: [8, 120] as const,
      /** Harmonic Distortion: 0 = seno puro, 1 = impulso. Típico PPG saludable 0.15–0.60. */
      HARMONIC_DISTORTION: [0, 1] as const,
    },
    WEIGHTS: {
      RESISTANCE: { k: 0.15, ipa: 0.40, decay: 0.45 },
      COMPLIANCE: { stiff: 0.10, si: 0.30, aix: 0.28, vMax: 0.02, sutRatio: 0.30 },
      REFLECTION: { dDivA: 0.30, agi: 0.20, dicroticDepth: 0.30, stiffnessIndex: 0.20 },
      FUSION: { hemodynamic: 0.52, morphology: 0.48 },
      MORPHOLOGY: {
        sbp: { sut: 0.30, stiff: 0.28, dicrotic: 0.22, aix: 0.12, hr: 0.08 },
        dbp: { pw50: 0.26, diaPhase: 0.24, decay: 0.20, dicrotic: 0.12, hrv: 0.08, ipa: 0.10 },
      },
    },
  },
  
  // SIGNAL QUALITY (SQI)
  QUALITY: {
    /** SQI mínimo para publicar BPM en UI (la onda puede verse antes) */
    MIN_FOR_HR: 10,
    /** Confianza mínima del ensemble para mostrar BPM en contacto inestable */
    MIN_ENSEMBLE_CONF_UNSTABLE: 0.12,
    MIN_ENSEMBLE_CONF_STABLE: 0.09,
    /** Confianza mínima del ensemble para emitir pico audible/visual */
    MIN_ENSEMBLE_CONF_FOR_PEAK: 0.12,
    /** Acuerdo Elgendi mínimo para alimentar arritmias */
    MIN_DETECTOR_AGREEMENT_ARRHYTHMIA: 0.55,
    MIN_FOR_CLINICAL: 55,
    /**
     * PI (AC/DC) para ADQUISICIÓN (transición a UNSTABLE) — holgado porque el AE
     * tarda 1-3 s en asentarse y el PI real tarda en emerger del ruido.
     */
    MIN_PI: 0.0009,
    /**
     * PI mínimo para MANTENER STABLE_CONTACT (anti falso-positivo "posición perfecta"):
     * 0.0009 (adquisición) es indistinguible del ruido del AE con flash → bastaba para
     * declarar STABLE sin pulso real. 0.0020 exige pulso REAL y sostenido.
     */
    STABLE_MIN_PI: 0.0020,
    /**
     * Cobertura ROI mínima para MANTENER STABLE_CONTACT. MIN_COVERAGE (0.09) cubre
     * apenas el 9% del frame — trivial con un dedo mal colocado. STABLE exige
     * cubrir bien la lente (>=0.35 ≈ 1/3 del ROI). No sustituye a MIN_COVERAGE:
     * la adquisición temprana (UNSTABLE) sigue usándola.
     */
    STABLE_MIN_COVERAGE: 0.35,
    /** STABLE se revierte a UNSTABLE tras estos frames SIN pulso confirmado (30 ≈ 1 s). */
    STABLE_MAX_NO_PULSE_FRAMES: 30,
    MAX_MOTION: 0.75,
    MAX_JITTER_MS: 55,
    /** Frames con dedo candidato antes de STABLE (≈0,53 s @ 30 fps) */
    STABLE_FRAMES_REQ: 16,
    /** EMA del SQI mostrado en UI (0–1 por frame) */
    DISPLAY_SQI_EMA_ALPHA: 0.2,
    /** Solo vaciar buffers DSP tras este tiempo en NO_CONTACT (evita “todo/nada”) */
    BUFFER_RESET_AFTER_NO_CONTACT_FRAMES: 8,
    /** Overlay diagnóstico — evita parpadeo VALID ↔ LOW_SIGNAL_QUALITY */
    DIAG_SQI_EMA_ALPHA: 0.14,
    DIAG_ENTER_LOW_SQI: 22,
    DIAG_EXIT_VALID_SQI: 26,
    DIAG_LOW_FRAMES_REQ: 10,
    DIAG_VALID_FRAMES_REQ: 4,
    /**
     * MICRO-MOVIMIENTO DEL DEDO DESDE LA SEÑAL (complementa al IMU). El IMU solo
     * capta que se mueva el teléfono; el micro-movimiento del dedo contra el lente
     * —artefacto dominante en PPG por cámara (~11 BPM de error, lit. 2019–2024)—
     * se ve como un ESCALÓN brusco del DC del rojo crudo entre frames, mucho mayor
     * que el incremento pulsátil (el pulso es lento: <1% del DC por frame). Se mapea
     * |ΔrawRed|/DC a un score [0..1] y se fusiona (max) con el motionScore del IMU
     * que alimenta el supresor de emisión (peakEmitMotionSuppress). Conservador:
     * zona muerta amplia + EMA lenta → solo el movimiento SOSTENIDO suprime; un
     * latido aislado nunca alcanza el umbral.
     */
    MOTION_DC_JUMP_DEADZONE: 0.005,
    MOTION_DC_JUMP_SCALE: 0.02,
    MOTION_SIGNAL_EMA_ALPHA: 0.35,
    /**
     * SQI POR SKEWNESS (Elgendi 2016, "Optimal SQI for PPG"): el índice de calidad
     * más fuerte. PPG limpio = skewness POSITIVA (subida sistólica abrupta → cola a
     * la derecha); ruido simétrico / corrupción por movimiento = skewness ≈0 o
     * negativa. Se usa como PENALIZACIÓN SUAVE (factor [FLOOR..1]) de la confianza
     * del ensemble, NO como bloqueo duro: una ventana ruidosa baja su confianza
     * (menos FP) pero un latido real (skew>HIGH) nunca se penaliza ni se pierde.
     * factor = FLOOR + (1−FLOOR)·clamp((skew−LOW)/(HIGH−LOW),0,1).
     */
    SKEWNESS_SQI_LOW: -0.3,
    SKEWNESS_SQI_HIGH: 0.2,
    SKEWNESS_SQI_FLOOR: 0.55,
    /**
     * HONESTIDAD DE LA ONDA: la altura mostrada se multiplica por la fuerza
     * pulsátil real = f(perfusión) × f(periodicidad). Por debajo del piso de
     * perfusión (ruido de objeto inerte) o sin periodicidad cardíaca → onda PLANA;
     * con perfusión + periodicidad reales (dedo) → onda completa. Ver waveHonesty.ts.
     */
    WAVE_PI_FLOOR: 0.0004,
    WAVE_PI_REF: 0.003,
    WAVE_PERIODICITY_REF: 0.25,
  },

  /**
   * ACQUISITION STABILIZATION — fase inicial de colocación del dedo.
   *
   * Fusiona métricas ya calculadas por el pipeline (PI, periodicidad,
   * SQI, cobertura, movimiento) en una confianza suavizada [0..1] con
   * histéresis y dwell, produciendo un estado SEARCHING → STABILIZING →
   * READY y un progreso monótono para la UI. Evita el parpadeo de
   * "dedo sí/no" y entrega una lectura inicial firme.
   *
   * Base: la cámara y el AE tardan ~1–3 s en estabilizarse al apoyar el
   * dedo (frames iniciales ruidosos); un periodo de warm-up + persistencia
   * temporal del SQI es la práctica validada para PPG por smartphone.
   */
  ACQUISITION: {
    /** Frames mínimos con contacto antes de poder declarar READY (≈1,2 s @30 fps). */
    WARMUP_FRAMES: 36,
    /** Frames sostenidos sobre el umbral de entrada antes de pasar a READY (debounce). */
    READY_DWELL_FRAMES: 10,
    /** Frames bajo el umbral de salida antes de abandonar READY (debounce anti-parpadeo). */
    EXIT_DWELL_FRAMES: 8,
    /** Confianza para entrar en READY (histéresis alta). */
    CONF_ENTER_READY: 0.55,
    /** Confianza para salir de READY (histéresis baja). */
    CONF_EXIT_READY: 0.38,
    /** EMA de subida de la confianza (sube relativamente rápido). */
    CONF_ATTACK: 0.14,
    /** EMA de bajada de la confianza (cae lento → lectura firme, sin oscilar). */
    CONF_RELEASE: 0.05,
    /** Objetivos de normalización por métrica (rangos típicos cámara+dedo). */
    PI_TARGET: 0.0018,
    PERIODICITY_TARGET: 0.42,
    SQI_TARGET: 45,
    COVERAGE_TARGET: 0.15,
    /** Movimiento por encima del cual se penaliza la confianza (escala 0..1 del score). */
    MOTION_TOLERANCE: 0.6,
    /** Pesos de fusión (suman 1.0). */
    W_PI: 0.30,
    W_PERIODICITY: 0.28,
    W_SQI: 0.24,
    W_COVERAGE: 0.18,
    /** Suavizado del progreso UI: subida máxima por frame y caída lenta. */
    PROGRESS_MAX_RISE: 0.035,
    PROGRESS_DECAY: 0.02,
  },

  /**
   * ESTABILIZACIÓN POR CONVERGENCIA (criterio REAL, no timer).
   *
   * La señal NO está estable "por tiempo": está estable cuando la LECTURA DE HR
   * dejó de moverse (convergió) Y la calidad se sostiene. No revela la onda hasta
   * que la medición es confiable; el tiempo que tarda lo dicta la SEÑAL, no un reloj
   * (señal limpia → converge en pocos segundos; señal pobre → nunca converge →
   * no revela basura). Esto reemplaza el warm-up fijo (que se sentía simulado).
   *
   * READY = el BPM (suavizado, robusto a arritmia) se mantuvo dentro de un margen
   * estrecho durante una ventana mínima, con SQI/PI/periodicidad sostenidos y poco
   * movimiento. El progreso refleja el PEOR de los criterios (eslabón débil) → es
   * honesto: si la convergencia o la calidad no avanzan, el progreso se estanca.
   */
  STABILIZATION: {
    /** Ventana deslizante de BPM para medir convergencia (ms). */
    WINDOW_MS: 4500,
    /** Span temporal MÍNIMO de BPM válido y convergido antes de READY (ms). El
     *  mínimo físico para confirmar que un ritmo se asentó — NO un warm-up ciego. */
    MIN_WINDOW_MS: 3000,
    /** Muestras mínimas de BPM válido en la ventana. */
    MIN_SAMPLES: 40,
    /** Margen máx (max−min) del BPM en la ventana para considerarlo CONVERGIDO (bpm). */
    BPM_SPREAD_MAX: 6,
    /** Frames de calidad sostenida (SQI/PI/periodicidad/movimiento) requeridos. */
    QUALITY_DWELL_FRAMES: 30,
    /** Umbrales de calidad instantánea (sostenidos durante el dwell). */
    MIN_SQI: 32,
    MIN_PI: 0.0010,
    MIN_PERIODICITY: 0.30,
    MAX_MOTION: 0.6,
    /** Suavizado del progreso (subida/bajada por frame). */
    PROGRESS_RISE: 0.05,
    PROGRESS_FALL: 0.03,
  },

  /**
   * ACONDICIONADOR ACTIVO DE SEÑAL (DSP en vivo): estabiliza la línea base y hace
   * denoise que PRESERVA los picos (edge-preserving). Trabaja la señal frame a frame.
   * Unidades en la escala de `pulseSource` (~±95). Ver activeStabilizer.ts.
   */
  ACTIVE_STAB: {
    /** EMA de la línea base (lenta: no se come el pulso, sí quita la deriva). */
    BASELINE_ALPHA: 0.012,
    /** Umbral de "flanco/pico": |Δ| por encima → se sigue (no se suaviza). */
    EDGE_THRESHOLD: 6,
    /** Suavizado mínimo en zona plana (peso a la muestra nueva con ruido chico). */
    ALPHA_MIN: 0.30,
  },

  /**
   * ROI ADAPTATIVO POR PÍXEL + MÁSCARA BEER-LAMBERT DIFERENCIAL.
   *
   * Cada píxel muestreado mantiene su propia densidad óptica (OD) temporal en el
   * canal verde. La máscara resultante:
   *   1. Excluye saturación (R ≥ SATURATION_RED) y subexposición (R ≤ UNDEREXPOSED_RED).
   *   2. Excluye píxeles cuyo AC/DC fisiológico cae fuera de [AC_DC_MIN, AC_DC_MAX]
   *      (0.1%–3%), calculado sobre la varianza de la OD (Beer-Lambert diferencial).
   *   3. Pondera la agregación por pulsatilidad OD y actividad diferencial |ΔOD|.
   *   4. Compara la máscara con la del frame anterior (Jaccard + desplazamiento de
   *      centroide) para detectar y penalizar movimiento del dedo antes del latido.
   *
   * Fallback seguro: si ningún píxel alcanza el rango fisiológico (arranque o escena
   * sin pulso), se usa la máscara de exposición válida. El resto del pipeline sigue
   * exigiendo perfusión real, así que este fallback nunca publica un latido falso.
   */
  PIXEL_ROI: {
    /** R ≥ este valor = píxel saturado (clipping del sensor). */
    SATURATION_RED: 250,
    /** R ≤ este valor = píxel subexpuesto (sin información útil). */
    UNDEREXPOSED_RED: 15,
    /**
     * SELLADO ÓPTICO POR TEJIDO (independiente de la AC).
     *
     * Un píxel es "tejido del dedo" cuando el rojo domina al promedio de verde y
     * azul (la hemoglobina absorbe verde/azul y deja pasar rojo). Esta prueba NO
     * depende de la pulsación ni de la exposición: un dedo que cubre la lente da
     * sellado alto aunque el sensor sature, y una pared blanca da sellado ≈ 0
     * aunque esté perfectamente expuesta.
     *
     * Sin esta separación, "cobertura" se confundía con "píxeles con AC/DC
     * fisiológico" → con el flash encendido el rojo satura, el filtro AC/DC
     * colapsa y la cobertura parecía baja con el dedo bien apoyado.
     */
    TISSUE_DOMINANCE_MIN: 8,
    TISSUE_RED_MIN: 24,
    TISSUE_GREEN_MIN: 10,
    /** Límite inferior del AC/DC fisiológico por píxel (0.1%). */
    AC_DC_MIN: 0.001,
    /** Límite superior del AC/DC fisiológico por píxel (3%). */
    AC_DC_MAX: 0.03,
    /** Muestras mínimas antes de aplicar el filtro fisiológico (evita rechazo en frío). */
    MIN_STAT_SAMPLES: 10,
    /** Píxeles fisiológicos mínimos para aceptar la máscara fisiológica; si no, fallback. */
    MIN_PHYSIOLOGICAL_PIXELS: 12,
    /** EMA de la OD media y de su varianza (≈0,67 s @30 fps). */
    OD_EMA_ALPHA: 0.07,
    /** |ΔOD| que satura la actividad diferencial de un píxel. */
    DOD_ACTIVITY_REF: 0.002,
    /** Jaccard mínimo para considerar que la máscara no se desplazó. */
    MASK_CORRELATION_MIN: 0.45,
    /** Desplazamiento de centroide que satura la penalización (fracción del ROI). */
    SHIFT_PENALTY_FRACTION: 0.12,
    /** Peso de la caída de correlación en la penalización. */
    CORRELATION_PENALTY_WEIGHT: 0.70,
    /** Peso del desplazamiento de centroide en la penalización. */
    SHIFT_PENALTY_WEIGHT: 0.30,
    /** Atenuación máxima de la señal PPG por desplazamiento detectado. */
    JITTER_ATTENUATION: 0.55,
    /** Alpha de seguimiento del centroide de búsqueda. */
    CENTER_TRACK_ALPHA: 0.18,
    /** Paso máximo del centroide de búsqueda por frame (fracción del frame). */
    CENTER_MAX_STEP: 0.08,
    /** Margen del bounding box del ROI efectivo (fracción del lado de búsqueda). */
    ROI_MARGIN_FRACTION: 0.02,
    /** Máscaras más pequeñas no se usan para correlación anti-jitter. */
    MIN_MASK_PIXELS_FOR_CORRELATION: 16,
    /** EMA de la penalización de desplazamiento (anti-parpadeo). */
    PENALTY_SMOOTH_ALPHA: 0.35,
  },

  /**
   * Arrhythmia / AF detection via weighted scoring over a multi-feature set.
   *
   * Sub-scores: clamp01((value - LO) / (HI - LO)) → [0,1].
   * Overall: weighted average of sub-scores.
   * Confidence: score ≥ MILD → "mild", ≥ MODERATE → "moderate", ≥ SEVERE → "severe".
   * Binary detection (callback): score ≥ DETECTION_THRESHOLD.
   */
  ARRHYTHMIA: {
    RR_WINDOW_SIZE: 10,
    MIN_INTERVALS: 9,
    MIN_SQI: 62,
    /**
     * FASES DE ARRANQUE (anti falsos positivos):
     *   0 – QUIET_PERIOD_MS (8 s): NADA. El sistema aún se asienta (AE/baseline/
     *     AGC); cualquier "irregularidad" aquí es transitorio de arranque, no
     *     arritmia. Estado UI: "CALIBRANDO...".
     *   QUIET – LEARNING_PERIOD_MS (8–18 s, warm-up de 10 s): el sistema YA está
     *     estable → se APRENDE el patrón rítmico normal del usuario (spread de RR)
     *     sin detectar. Estado UI: "APRENDIENDO RITMO...".
     *   ≥ LEARNING_PERIOD_MS (18 s): recién aquí se detectan arritmias REALES,
     *     usando el deadband personalizado aprendido en el warm-up.
     */
    QUIET_PERIOD_MS: 8_000,
    LEARNING_PERIOD_MS: 18_000,
    /**
     * DEADBAND ANTI-JITTER personalizado (causa raíz de FP en cámara: el jitter de
     * localización de pico ±1–2 muestras ≈ 33–66 ms satura pNN31/pNN325). Tras el
     * warm-up se aprende el spread normal del usuario (p90 de |RR−mediana|) y se fija
     * el piso = clamp(max(RR_JITTER_FLOOR_MS, p90·FACTOR), FLOOR, MAX). En detección,
     * todo RR a < piso de la mediana se colapsa a la mediana → el jitter normal
     * desaparece, las desviaciones grandes (arritmia real >100 ms) sobreviven.
     */
    RR_JITTER_FLOOR_MS: 70,
    LEARNED_FLOOR_FACTOR: 1.4,
    LEARNED_FLOOR_MAX_MS: 150,
    MIN_EVENT_INTERVAL_MS: 6000,
    OUTLIER_RATIO: 0.16,
    ABRUPT_RR_FRAC: 0.16,
    IRREGULAR_DIFF_MS: 165,

    // ── Sub-score thresholds (LO = normal ceiling, HI = strong AF floor)
    RMSSD_LO: 28,
    RMSSD_HI: 80,
    CV_LO: 0.07,
    CV_HI: 0.18,
    PNN31_LO: 0.18,
    PNN31_HI: 0.50,
    PNN325_LO: 0.14,
    PNN325_HI: 0.40,
    PNN50_LO: 0.08,
    PNN50_HI: 0.30,
    TPR_TARGET: 0.67,
    SHANNON_LO: 1.80,
    SHANNON_HI: 3.50,
    SAMPEN_LO: 0.50,
    SAMPEN_HI: 1.50,
    OUTLIER_LO: 1,
    OUTLIER_HI: 5,
    ABRUPT_LO: 1,
    ABRUPT_HI: 5,
    RRVAR_LO: 0.07,
    RRVAR_HI: 0.25,

    // ── Feature weights (RMSSD..RRVAR suman 1.0; ECTOPY se añade y se renormaliza)
    W_RMSSD: 0.15,
    W_CV: 0.10,
    W_PNN31: 0.20,
    W_PNN325: 0.20,
    W_PNN50: 0.05,
    W_TPR: 0.05,
    W_SHANNON: 0.05,
    W_SAMPEN: 0.10,
    W_OUTLIER: 0.05,
    W_ABRUPT: 0.03,
    W_RRVAR: 0.02,
    /** Latidos prematuros (ectopia): peso del sub-score en el total. */
    W_ECTOPY: 0.12,

    /**
     * Latidos prematuros (PVC/PAC) — firma fisiológica "acoplamiento corto +
     * pausa compensatoria": un latido adelantado seguido de una pausa, cuya
     * suma se aproxima a 2× el RR basal (PVC: pausa completa; PAC: incompleta).
     * Umbrales conservadores para no confundir el jitter de detección de picos
     * con extrasístoles reales.
     */
    PREMATURE_SHORT_FRAC: 0.75,
    PREMATURE_COMP_MIN: 1.10,
    PREMATURE_PAIR_TOL: 0.18,
    /** ≥ este nº de prematuros en la ventana → arritmia (ectopia frecuente: trigeminismo+). */
    ECTOPY_MIN_FLAG: 3,
    /** Saturación del sub-score de ectopia. */
    ECTOPY_HI: 3,
    /**
     * Confirmación temporal: la arritmia debe SOSTENERSE este tiempo (ms) antes
     * de marcarse, para rechazar falsos positivos transitorios (jitter, un latido
     * mal detectado). Una arritmia real (FA, ectopia frecuente) es persistente.
     */
    ARRHYTHMIA_CONFIRM_MS: 2500,

    // ── Score cutoffs
    MILD_THRESHOLD: 0.30,
    MODERATE_THRESHOLD: 0.45,
    SEVERE_THRESHOLD: 0.65,
    DETECTION_THRESHOLD: 0.50,
  },

  // FINGER + ROI (cámara trasera + dedo; hemoglobina + pulsación temporal)
  // NOTA: umbrales relajados para tolerar dedo no perfectamente centrado
  // (ROI más grande, centerBias más plano, tiles más permisivos)
  // ENSEMBLE: detección multi-métrica universal (brightness + coverage + histogram + temporal variance)
  FINGER: {
    /** Fracción del lado corto del frame usada como ventana de búsqueda del ROI. */
    ROI_SIZE_FRACTION: 0.82,
    MIN_RED_INTENSITY: 36,
    MIN_RED_DOMINANCE: 5,
    MIN_RG_RATIO: 1.00,
    ENSEMBLE_FINGER_THRESHOLD: 0.50,
    MIN_COVERAGE: 0.09,
    /** R/B mínimo — dedo absorbe azul; flash sin dedo suele fallar esto */
    HEMOGLOBIN_MIN_RB: 1.15,
    SOFT_COVERAGE_MULT: 0.85,
    /** Adquisición estricta */
    ACQUIRE_RB_STRICT: 1.2,
    ACQUIRE_INTENSITY_MIN: 68,
    ACQUIRE_INTENSITY_MAX: 780,
    ACQUIRE_SMOOTHED_FINGER_MIN: 0.14,
    ACQUIRE_MAX_MOTION_STRICT: 0.85,
    /** Adquisición suave (parcial / flash desigual) */
    ACQUIRE_SOFT_MIN_RED: 28,
    ACQUIRE_SOFT_RG: 1.025,
    ACQUIRE_SOFT_RB: 1.16,
    ACQUIRE_SOFT_DOMINANCE: 8,
    ACQUIRE_SOFT_INTENSITY_MIN: 52,
    ACQUIRE_SOFT_INTENSITY_MAX: 850,
    ACQUIRE_SOFT_FINGER_SCORE_ROI: 0.18,
    ACQUIRE_SOFT_SMOOTHED_FINGER: 0.15,
    ACQUIRE_MAX_MOTION_SOFT: 0.90,
    /** Mantener contacto */
    MAINTAIN_MIN_RED: 28,
    MAINTAIN_RG: 1.03,
    MAINTAIN_RB: 1.10,
    MAINTAIN_DOMINANCE: 5.0,
    MAINTAIN_COVERAGE: 0.065,
    /** Mantener por PI cuando la firma RGB falla un frame */
    PULSE_HOLD_MIN_PI: 0.00030,
    PULSE_HOLD_MIN_RED: 28,
    PULSE_HOLD_RG: 1.03,
    PULSE_HOLD_RB: 1.05,
    PULSE_HOLD_COVERAGE: 0.080,
    PULSE_HOLD_MAX_MOTION: 0.80,
    /** Pulsación ROI (CV de rawRed) — tercera vía de adquisición */
    ROI_PULSE_BUFFER: 24,
    ROI_PULSE_MIN_SAMPLES: 12,
    /** Solo para mantener contacto ya adquirido (no adquisición inicial) */
    ROI_RED_CV_MIN: 0.036,
    PULSATILE_ACQUIRE_MIN_RED: 26,
    PULSATILE_ACQUIRE_RG: 1.02,
    PULSATILE_ACQUIRE_RB: 1.05,
    PULSATILE_ACQUIRE_COVERAGE: 0.075,
    PULSATILE_ACQUIRE_FINGER_ROI: 0.12,
    PULSATILE_ACQUIRE_MAX_MOTION: 1.0,
    PULSATILE_ACQUIRE_MIN_DOMINANCE: 4.4,
    /** Número mínimo de regiones equivalentes con señal para considerar contacto. */
    MIN_FINGER_TILES_FOR_WEIGHTING: 2,
    FINGER_CONFIRM_FRAMES: 5,
    /** Tras perder firma instantánea: frames hasta degradar */
    INSTANT_LOST_TO_UNSTABLE: 2,
    INSTANT_LOST_TO_NO_CONTACT: 4,
    FINGER_LOST_FRAMES_UI: 6,
    UNSTABLE_GRACE_FRAMES: 0,
    /** softHold al perder instantáneo — solo si la firma RGB aún es válida */
    SOFT_HOLD_COVERAGE: 0.11,
    SOFT_HOLD_DOMINANCE_DELTA: 6,
    SOFT_HOLD_FINGER_SCORE: 0.14,
    SOFT_HOLD_RG: 1.04,
  },

  /**
   * PRESIÓN TRANSMURAL (microvascular blanching) — MODELO ÚNICO de presión.
   *
   * La cámara no mide fuerza ni mmHg: el modelo estima el estado RELATIVO del
   * lecho capilar (presión transmural Pt = Pa − Pe) con señales ya medidas por
   * el pipeline. Anclas publicadas:
   *  - Teng & Zhang, Physiol. Meas. 25(5):1323–1335 (2004): con 0.2–1.8 N el DC
   *    sube de forma monótona; AC y AC/DC suben hasta un máximo (0.2–1.0 N, la
   *    mayoría 0.2–0.4 N) y después caen.
   *  - May, Mejía-Mejía et al., Sensors 21(24):8421 (2021): óptimo de SNR a
   *    35.1–48.1 mmHg de presión de contacto.
   *  - Biomed. Eng. Lett. (2024): 20–30 mmHg (presión leve) hasta la DBP da los
   *    mejores índices; por encima de la MAP aparece sobrenormalización.
   *  - Sensors 24(9):2692 (2024): el DC correlaciona con la fuerza de contacto,
   *    con histéresis entre carga y descarga.
   *  - IEEE TIM 2023 (tonometría MW-PPG): máxima pulsación en Pt≈0; al subir Pe
   *    colapsan primero capilares/arteriolas superficiales y luego el lecho
   *    profundo.
   *
   * PROHIBIDO crear otro clasificador de presión: este bloque y
   * `src/lib/pressure/transmuralPressureModel.ts` son la fuente única;
   * `fingerPlacementEvidence.ts` solo agrega ubicación/cobertura/movimiento.
   */
  PRESSURE: {
    /*
     * ── SELLADO (cobertura de lente por tejido) ──────────────────────────────
     * Se mide como fracción de píxeles del área explorada que son tejido del
     * dedo, EXCLUYENDO el filtro AC/DC (ver PIXEL_ROI.TISSUE_*). Responde a
     * "¿la yema cubre la lente?" sin confundirse con la exposición.
     */
    /** Sellar por debajo de esto = no hay apoyo del dedo. */
    COVER_MIN: 0.10,
    /** Lente cubierta por la yema. */
    COVER_GOOD: 0.42,

    /*
     * ── PULSATILIDAD (AC/DC) ─────────────────────────────────────────────────
     * Responde a "¿hay flujo sanguíneo?" y es el eje del colapso capilar.
     */
    /** PI RAW (AC/DC) que representa pulso pleno en este sensor. */
    PI_REF: 0.004,
    /** PI normalizado mínimo para considerar apoyo óptimo. */
    PULSE_OK: 0.40,
    /** Mejor PI reciente mínimo para poder diagnosticar colapso relativo. */
    AC_PEAK_MIN_PI: 0.0016,
    /** Mejora relativa mínima para mover el PI de referencia (anti-deriva). */
    PI_PEAK_MARGIN: 0.02,
    /** Fracción del PI de referencia que confirma la salida de colapso. */
    PI_RECOVER: 0.80,
    /** Caída de PI que aún cae dentro del plateau óptimo (histéresis fina). */
    PI_DEFICIT_OPTIMAL: 0.15,
    /** Caída de PI que ya justifica pedir más apoyo. */
    PI_DEFICIT_LIGHT: 0.25,
    /** CV temporal del rojo que marca el piso de pulsatilidad. */
    CV_FLAT_REF: 0.012,
    /**
     * Margen relativo para declarar TENDENCIA del PI (subiendo/bajando).
     * Un dedo vasoconstrigido que se recalienta bajo el flash ve subir su PI de
     * forma monótona; un dedo aplastado no. Es el segundo signo que separa
     * frío/estrés de presión mecánica (Sci Rep 2020;10:6741: la vasoconstricción
     * baja la AC con el DC estable; la presión mecánica la baja con el DC arriba).
     */
    PI_TREND_MARGIN: 0.06,

    /*
     * ── DC = FUERZA DE CONTACTO (Teng 2004, Sensors 2024) ───────────────────
     * El DC sube de forma monótona con la fuerza. Se compara contra el DC que
     * había cuando el dedo selló la lente por primera vez en el episodio
     * (`dcRef`), no contra el mínimo global: así la deriva del AE antes del
     * contacto no falsea la lectura de fuerza.
     */
    DC_DYNAMIC_SPAN: 0.30,
    DC_MIN_SPAN: 12,
    DC_MIN_BASELINE: 12,
    DC_REF_FLOOR: 24,
    DC_DISPLACE_MIN: 0.08,
    DC_RISE_MIN: 0.18,
    DC_RISE_FULL: 0.10,
    DC_HIGH_MIN: 0.14,

    /*
     * ── BLANQUEO MICROVASCULAR ──────────────────────────────────────────────
     * Índice [0..1]. El colapso de la AC es el signo primario; el DC alto y la
     * planitud del CV solo lo confirman. Exige sellado suficiente: con fuga de
     * luz la AC baja por falta de acoplamiento, no por isquemia.
     */
    BLANCH_ENTER: 0.55,
    BLANCH_EXIT: 0.32,
    BLANCH_AC_WEIGHT: 0.62,
    BLANCH_FLAT_WEIGHT: 0.18,
    BLANCH_DC_WEIGHT: 0.20,
    /** Sellado mínimo para que el blanqueo sea evaluable. */
    BLANCH_COUPLING_MIN: 0.55,

    /*
     * ── CONFIRMACIÓN TEMPORAL ───────────────────────────────────────────────
     * La respuesta debe ser rápida: el usuario está corrigiendo en tiempo real.
     */
    MIN_EVIDENCE_FRAMES: 10,
    HEAVY_WARMUP_FRAMES: 12,
    HEAVY_ENTER_FRAMES: 5,
    VERDICT_CONFIRM_FRAMES: 6,

    /** Suavizados de evidencia. */
    EMA_FAST: 0.30,
    EMA_SLOW: 0.02,
    /** EMA del grado continuo de presión (cursor del gauge). */
    SCORE_ALPHA: 0.25,

    /*
     * ── GUÍA Y HÁPTICO ──────────────────────────────────────────────────────
     * El primer aviso no espera asentamiento: si el dedo está mal apoyado hay
     * que decirlo ya. La repetición sí mantiene cadencia para no saturar.
     */
    GUIDANCE_MIN_CONFIDENCE: 0.30,
    /**
     * El PRIMER aviso de cada estado es inmediato. Solo la repetición lleva
     * cadencia, y debe ser lo bastante rápida para que el usuario esté corrigiendo
     * de verdad: 9 s entre avisos de "presiona más" dejaba al usuario a ciegas
     * justo mientras ajustaba el dedo.
     */
    FEEDBACK_SETTLE_MS: 900,
    HEAVY_REPEAT_MS: 2500,
    LIGHT_REPEAT_MS: 4500,
    HAPTIC_MIN_INTERVAL_MS: 700,
    HAPTIC_SEVERE_FRACTION: 0.75,
    CONTACT_LOST_FRAMES: 6,
  },

  /**
   * REINICIO POR PÉRDIDA/REGANANCIA DE CONTACTO (frame-gates @ ~30 fps).
   * Fuente única consumida por useHeartBeatProcessor y useSignalRouter — antes
   * estaban hardcodeados y desalineados en cada hook. Tolerantes a parpadeos
   * breves: un artefacto corto no corta la detección ni obliga a re-ritmar.
   */
  CONTACT: {
    /** useHeartBeatProcessor: ~1,1 s sin dedo → re-adquisición SUAVE de picos */
    SOFT_RESET_FRAMES: 33,
    /** useHeartBeatProcessor: ~1,6 s sin dedo → reset COMPLETO del procesador */
    HARD_RESET_FRAMES: 48,
    /** useSignalRouter: NO_CONTACT sostenido → reset de sesión de dedo */
    SESSION_RESET_FRAMES: 25,
    /** useSignalRouter: frames sin contacto previos para que un re-contacto dispare reset */
    REGAIN_RESET_MIN_FRAMES: 30,
    /** useSignalRouter: frames con dedo sin BPM → re-adquisición de picos */
    STALE_PEAK_REACQUIRE_FRAMES: 40,
    /** useSignalRouter: frames con dedo sin BPM → reset agresivo de SpO2/BP */
    STALE_NO_BPM_FRAMES: 90,
    /** useSignalRouter: frames de cero/inestable antes de limpiar todo el estado */
    UNSTABLE_ZERO_THRESHOLD_FRAMES: 60,
  },

  /**
   * ORQUESTACIÓN DEL ROUTER (useSignalRouter): cadencia de procesamiento DSP,
   * throttles de push a estado React (evitan rerenders por frame) y knobs de
   * gating que NO viven en el path de detección. Cero efecto sobre la matemática
   * de la señal; solo controlan frecuencia de actualización de UI y umbrales de
   * conteo de artefactos.
   */
  ROUTER: {
    /** Procesar DSP de vitals cada N frames de señal */
    VITALS_PROCESS_EVERY_N_FRAMES: 3,
    /** Throttles de push a estado React (ms) */
    HR_PUSH_THROTTLE_MS: 80,
    VITALS_PUSH_THROTTLE_MS: 300,
    RR_PUSH_THROTTLE_MS: 250,
    SIGNAL_PUSH_THROTTLE_MS: 16,
    DIAG_PUSH_THROTTLE_MS: 200,
    FACE_PUSH_THROTTLE_MS: 100,
    DUAL_STREAM_PUSH_THROTTLE_MS: 250,
    /** Duración del marcador de latido en UI (ms) */
    BEAT_MARKER_MS: 300,
    /** Cooldown entre toasts de señal sospechosa (ms) */
    SANITY_TOAST_COOLDOWN_MS: 5000,
    /** Ratio de frames saturados/subexpuestos para contabilizar artefacto */
    SATURATION_FRAME_RATIO: 0.75,
    UNDEREXPOSURE_FRAME_RATIO: 0.82,
    /** Escala y piso del PI mínimo aplicados en evaluateMeasurementReadiness */
    PI_MIN_READINESS_SCALE: 0.18,
    PI_MIN_READINESS_FLOOR: 0.04,
    /** Confianza mínima de fusión dual-stream para usar su BPM de consenso (0–100) */
    FUSION_CONSENSUS_MIN_CONF: 60,
    /** Confianza mínima del ensemble para alimentar arritmia desde el router */
    ARRHYTHMIA_MIN_CONF: 0.15,
  },
};

export const CALIBRATION_CONFIG = {
  SPO2_REQUIRED_SAMPLES: 15,
  BP_REQUIRED_SAMPLES: 25,
  EXPIRATION_DAYS: 30,
};
