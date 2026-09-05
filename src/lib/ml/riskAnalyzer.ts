import type { VitalSignsResult } from '../../modules/vital-signs/VitalSignsProcessor';

export interface HealthRiskScore {
  overall: number;
  categories: {
    cardiovascular: number;
    respiratory: number;
    arrhythmia: number;
    hypertension: number;
    hypoxia: number;
  };
  flags: string[];
  recommendations: string[];
  timeline: 'IMMEDIATE' | 'SOON' | 'MONITOR' | 'NORMAL';
}

export interface RiskWeights {
  base: number;
  age: number;
  bmi: number;
  smoking: number;
  diabetes: number;
  familyHistory: number;
}

/**
 * Analizador informativo de bienestar cardiovascular y respiratorio.
 * Producto de bienestar general: NO es dispositivo medico, NO diagnostica
 * ni prescribe. Evalua unicamente variables fisiologicas medidas,
 * normalizando ponderaciones de forma dinamica sin fabricar valores ficticios.
 * Toda salida es orientativa y debe interpretarse junto a un profesional.
 */
export class HealthRiskAnalyzer {
  private readonly BASE_WEIGHTS = {
    cardiovascular: 0.30,
    respiratory: 0.15,
    arrhythmia: 0.20,
    hypertension: 0.20,
    hypoxia: 0.15,
  };

  analyze(
    vitals: VitalSignsResult,
    profile?: Partial<RiskWeights>,
    age?: number,
  ): HealthRiskScore {
    const hr = vitals.heartRate.value;
    const hasHr = typeof hr === 'number' && hr > 0;

    const spo2 = vitals.spo2.value;
    const hasSpo2 = typeof spo2 === 'number' && spo2 > 0;

    const sys = vitals.bloodPressure.value?.systolic;
    const dia = vitals.bloodPressure.value?.diastolic;
    const hasBp = typeof sys === 'number' && typeof dia === 'number' && sys > 0 && dia > 0;

    const respRate = vitals.respiration.value;
    const hasResp = typeof respRate === 'number' && respRate > 0;

    const arrhythmiaScore = vitals.arrhythmia.value?.score;
    const hasArr = typeof arrhythmiaScore === 'number' && arrhythmiaScore >= 0;

    const activeCategories: Partial<Record<keyof typeof this.BASE_WEIGHTS, number>> = {};

    if (hasHr || hasBp || profile) {
      activeCategories.cardiovascular = this.scoreCardiovascular(
        hasHr ? hr : null,
        hasBp ? sys! : null,
        hasBp ? dia! : null,
        profile,
        age,
      );
    }

    if (hasResp || hasSpo2) {
      activeCategories.respiratory = this.scoreRespiratory(
        hasResp ? respRate : null,
        hasSpo2 ? spo2 : null,
      );
    }

    if (hasArr) {
      activeCategories.arrhythmia = this.scoreArrhythmia(arrhythmiaScore!);
    }

    if (hasBp) {
      activeCategories.hypertension = this.scoreHypertension(sys!, dia!);
    }

    if (hasSpo2) {
      activeCategories.hypoxia = this.scoreHypoxia(spo2!, hasHr ? hr : undefined);
    }

    const categories: HealthRiskScore['categories'] = {
      cardiovascular: activeCategories.cardiovascular ?? 0,
      respiratory: activeCategories.respiratory ?? 0,
      arrhythmia: activeCategories.arrhythmia ?? 0,
      hypertension: activeCategories.hypertension ?? 0,
      hypoxia: activeCategories.hypoxia ?? 0,
    };

    // Normalización adaptativa de pesos sobre categorías con datos reales
    let totalAssessedWeight = 0;
    let weightedSum = 0;

    for (const [key, score] of Object.entries(activeCategories)) {
      const w = this.BASE_WEIGHTS[key as keyof typeof this.BASE_WEIGHTS];
      totalAssessedWeight += w;
      weightedSum += (score ?? 0) * w;
    }

    const overall = totalAssessedWeight > 0 ? weightedSum / totalAssessedWeight : 0;

    const flags = this.generateFlags(categories, vitals, {
      hasHr,
      hasSpo2,
      hasBp,
      hasResp,
      hasArr,
    });
    const timeline = this.determineTimeline(overall, flags);

    return {
      overall: Math.round(overall * 100) / 100,
      categories,
      flags,
      recommendations: this.generateRecommendations(categories, flags),
      timeline,
    };
  }

  private scoreCardiovascular(
    hr: number | null,
    sys: number | null,
    dia: number | null,
    profile?: Partial<RiskWeights>,
    age?: number,
  ): number {
    let score = 0;
    let components = 0;

    if (hr !== null) {
      score += Math.min(1, Math.abs(hr - 72) / 120) * 0.4;
      components += 0.4;
    }

    if (sys !== null && dia !== null) {
      const bpDev = Math.min(1, Math.abs(sys - 120) / 160) * 0.6 + Math.min(1, Math.abs(dia - 80) / 80) * 0.4;
      score += bpDev * 0.4;
      components += 0.4;
    }

    let profileFactor = 0;
    const effectiveAge = age ?? profile?.age;
    if (effectiveAge && effectiveAge > 40) {
      profileFactor += Math.min(1, (effectiveAge - 40) / 60) * 0.1;
    }
    if (profile?.smoking) profileFactor += 0.1;
    if (profile?.diabetes) profileFactor += 0.1;
    if (profile?.familyHistory) profileFactor += 0.05;

    if (components > 0) {
      score = (score / components) * (1 - Math.min(0.3, profileFactor)) + profileFactor;
    } else {
      score = profileFactor;
    }

    return Math.min(1, Math.max(0, score));
  }

  private scoreRespiratory(respRate: number | null, spo2: number | null): number {
    let rateScore = 0;
    if (respRate !== null) {
      if (respRate >= 12 && respRate <= 20) {
        rateScore = 0; // Eupnea fisiológica normal
      } else if (respRate > 20 && respRate <= 24) {
        rateScore = 0.25; // Taquipnea leve
      } else if (respRate > 24 && respRate <= 30) {
        rateScore = 0.55; // Taquipnea moderada
      } else if (respRate > 30) {
        rateScore = Math.min(1, 0.75 + (respRate - 30) * 0.025); // Taquipnea severa
      } else if (respRate >= 9 && respRate < 12) {
        rateScore = 0.35; // Bradipnea leve
      } else if (respRate >= 6 && respRate < 9) {
        rateScore = 0.70; // Bradipnea moderada
      } else {
        rateScore = 1.0; // Bradipnea severa / riesgo de apnea (< 6 RPM)
      }
    }

    let hypScore = 0;
    if (spo2 !== null) {
      if (spo2 >= 97) hypScore = 0;
      else if (spo2 >= 95) hypScore = 0.2;
      else if (spo2 >= 92) hypScore = 0.5;
      else if (spo2 >= 88) hypScore = 0.75;
      else hypScore = 1.0;
    }

    if (respRate !== null && spo2 !== null) {
      return Math.min(1, Math.max(rateScore, rateScore * 0.7 + hypScore * 0.3));
    }
    return respRate !== null ? rateScore : hypScore;
  }

  private scoreArrhythmia(score: number): number {
    return Math.min(1, Math.max(0, score));
  }

  private scoreHypertension(sys: number, dia: number): number {
    // Escala clínica AHA/ESC: 120-180 mmHg sistólica, 80-120 mmHg diastólica
    const sysScore = Math.min(1, Math.max(0, (sys - 120) / 60));
    const diaScore = Math.min(1, Math.max(0, (dia - 80) / 40));
    return Math.min(1, sysScore * 0.6 + diaScore * 0.4);
  }

  private scoreHypoxia(spo2: number, hr?: number): number {
    let spo2Risk = 0;
    if (spo2 < 90) {
      spo2Risk = Math.min(1, 0.75 + (90 - spo2) * 0.025);
    } else {
      spo2Risk = Math.min(0.70, Math.max(0, (98 - spo2) / 12));
    }
    const hrRisk = (hr && hr > 100) ? Math.min(1, (hr - 100) / 80) : 0;
    return Math.min(1, Math.max(spo2Risk, spo2Risk * 0.75 + hrRisk * 0.25));
  }

  private generateFlags(
    categories: HealthRiskScore['categories'],
    vitals: VitalSignsResult,
    availability: {
      hasHr: boolean;
      hasSpo2: boolean;
      hasBp: boolean;
      hasResp: boolean;
      hasArr: boolean;
    },
  ): string[] {
    const flags: string[] = [];
    const hr = vitals.heartRate.value;
    const spo2 = vitals.spo2.value;
    const sys = vitals.bloodPressure.value?.systolic;
    const dia = vitals.bloodPressure.value?.diastolic;
    const resp = vitals.respiration.value;

    if (availability.hasBp) {
      if (categories.hypertension > 0.7) flags.push('HIPERTENSION_SEVERA');
      else if (categories.hypertension > 0.4) flags.push('HIPERTENSION_MODERADA');
      if ((sys && sys >= 180) || (dia && dia >= 120)) flags.push('CRISIS_HIPERTENSIVA');
    }

    if (availability.hasSpo2) {
      if (categories.hypoxia > 0.7) flags.push('HIPOXIA_SEVERA');
      else if (categories.hypoxia > 0.4) flags.push('HIPOXIA_MODERADA');
      if (spo2 && spo2 < 90) flags.push('DESATURACION_CRITICA');
    }

    if (availability.hasArr) {
      if (categories.arrhythmia > 0.7) flags.push('ARRITMIA_SEVERA');
      else if (categories.arrhythmia > 0.4) flags.push('ARRITMIA_MODERADA');
    }

    if ((availability.hasHr || availability.hasBp) && categories.cardiovascular > 0.6) {
      flags.push('RIESGO_CARDIOVASCULAR_ELEVADO');
    }

    if (availability.hasHr && hr) {
      if (hr > 100) flags.push('TAQUICARDIA');
      else if (hr < 50) flags.push('BRADICARDIA');
    }

    if (availability.hasResp && resp) {
      if (resp > 24) flags.push('TAQUIPNEA');
      else if (resp < 10) flags.push('BRADIPNEA');
    }

    return flags;
  }

  private determineTimeline(
    overall: number,
    flags: string[],
  ): HealthRiskScore['timeline'] {
    if (
      overall > 0.7 ||
      flags.some(f =>
        ['CRISIS_HIPERTENSIVA', 'DESATURACION_CRITICA', 'HIPOXIA_SEVERA',
         'HIPERTENSION_SEVERA', 'ARRITMIA_SEVERA'].includes(f),
      )
    ) return 'IMMEDIATE';

    if (
      overall > 0.5 ||
      flags.some(f =>
        ['HIPERTENSION_MODERADA', 'HIPOXIA_MODERADA', 'ARRITMIA_MODERADA',
         'RIESGO_CARDIOVASCULAR_ELEVADO', 'TAQUIPNEA', 'BRADIPNEA'].includes(f),
      )
    ) return 'SOON';

    if (overall > 0.2) return 'MONITOR';
    return 'NORMAL';
  }

  private generateRecommendations(
    categories: HealthRiskScore['categories'],
    flags: string[],
  ): string[] {
    const recs: string[] = [];
    // Lenguaje de bienestar: informacion general + derivacion profesional.
    // Prohibido prescribir, ajustar medicacion, administrar oxigeno o indicar
    // pruebas clinicas concretas (FDA General Wellness 2026: sin treatment
    // guidance ni clinical management). Ante sintomas de alarma, emergencias.
    if (flags.includes('CRISIS_HIPERTENSIVA')) {
      recs.push('Lectura fuera del rango habitual de bienestar: consulte a un profesional de la salud cuanto antes. Ante sintomas de alarma (dolor de pecho, desmayo, dificultad respiratoria intensa), busque atencion de emergencia local de inmediato');
    }
    if (flags.includes('DESATURACION_CRITICA')) {
      recs.push('Lectura fuera del rango habitual de bienestar: consulte a un profesional de la salud cuanto antes. Ante sintomas de alarma, busque atencion de emergencia local de inmediato; no se automedique por esta lectura');
    }
    if (flags.includes('HIPERTENSION_SEVERA') || flags.includes('HIPERTENSION_MODERADA')) {
      recs.push('Patron fuera del rango habitual de bienestar: consulte a un profesional de la salud. No ajuste medicacion por su cuenta');
    }
    if (flags.includes('HIPOXIA_SEVERA') || flags.includes('HIPOXIA_MODERADA')) {
      recs.push('Patron fuera del rango habitual de bienestar: consulte a un profesional de la salud si persiste');
    }
    if (flags.includes('TAQUIPNEA')) {
      recs.push('Frecuencia respiratoria fuera del rango habitual de bienestar: descanse y consulte a un profesional de la salud si persiste o hay dificultad para respirar');
    }
    if (flags.includes('BRADIPNEA')) {
      recs.push('Frecuencia respiratoria fuera del rango habitual de bienestar: consulte a un profesional de la salud, especialmente si hay somnolencia o malestar');
    }
    if (flags.includes('ARRITMIA_SEVERA') || flags.includes('ARRITMIA_MODERADA')) {
      recs.push('Patron de pulso irregular: evite sacar conclusiones por su cuenta y consulte a un profesional de la salud para valoracion con equipo clinico');
    }
    if (flags.includes('TAQUICARDIA')) {
      recs.push('Pulso fuera del rango habitual de bienestar en reposo: descanse, hidratese y consulte a un profesional de la salud si persiste');
    }
    if (flags.includes('BRADICARDIA')) {
      recs.push('Pulso fuera del rango habitual de bienestar: si hay mareos, fatiga extrema o desmayos, busque atencion medica de inmediato');
    }
    if (categories.hypoxia > 0.2 && categories.hypoxia <= 0.4) {
      recs.push('Manténgase hidratado y ventile bien el área donde se encuentra');
    }
    if (flags.length === 0) {
      recs.push('Sus signos vitales medidos se encuentran dentro de parámetros normales');
      recs.push('Mantenga hábitos cardiovasculares saludables, hidratación y ejercicio regular');
    }
    return recs;
  }
}

export const healthRiskAnalyzer = new HealthRiskAnalyzer();
