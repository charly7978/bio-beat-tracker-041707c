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
 * Analizador informativo de bienestar basado SOLO en pulso medido.
 * Producto de bienestar general: NO es dispositivo medico, NO diagnostica
 * ni prescribe. SpO2/PA/respiración son estimaciones experimentales de cámara
 * (nunca equivalentes a oxímetro/tensiómetro) y POR ELLO NUNCA alimentan
 * puntuaciones ni banderas de riesgo: solo el pulso por temporización de
 * latidos (HR VALID) y la irregularidad RR con evidencia temporal contribuyen.
 * Las categorías hypertension/hypoxia/respiratory se conservan en el tipo por
 * compatibilidad pero siempre valen 0 (retiradas). Toda salida es orientativa
 * y debe interpretarse junto a un profesional.
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
    // Solo pulso MEDIDO (status VALID): los valores >0 con otro estado son
    // estimaciones en calentamiento o restos de sesión, no evidencia.
    const hr = vitals.heartRate.value;
    const hasHr =
      typeof hr === 'number' && hr > 0 && vitals.heartRate.status === 'VALID';

    // SpO2/PA/respiración: estimaciones experimentales — excluidas del riesgo
    // por diseño (nunca puntúan ni generan banderas, aunque vengan VALID).

    const arrhythmiaScore = vitals.arrhythmia.value?.score;
    const arrCount = vitals.arrhythmia.value?.count ?? 0;
    // Irregularidad solo con evidencia temporal: score numérico Y latidos
    // marcados o estado de medición válido (sin evidencia no hay categoría).
    const hasArr =
      typeof arrhythmiaScore === 'number' &&
      arrhythmiaScore >= 0 &&
      (arrCount > 0 || vitals.arrhythmia.status === 'VALID');

    const activeCategories: Partial<Record<keyof typeof this.BASE_WEIGHTS, number>> = {};

    if (hasHr || profile) {
      activeCategories.cardiovascular = this.scoreCardiovascular(
        hasHr ? hr : null,
        profile,
        age,
      );
    }

    if (hasArr) {
      activeCategories.arrhythmia = this.scoreArrhythmia(arrhythmiaScore!);
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
      hasArr,
    });
    const timeline = this.determineTimeline(overall, flags);

    return {
      overall: Math.round(overall * 100) / 100,
      categories,
      flags,
      recommendations: this.generateRecommendations(flags),
      timeline,
    };
  }

  /**
   * Desviación del pulso medido respecto al reposo habitual (72 lpm) más
   * factores de perfil. Solo usa HR: la PA experimental no entra aquí.
   */
  private scoreCardiovascular(
    hr: number | null,
    profile?: Partial<RiskWeights>,
    age?: number,
  ): number {
    let score = 0;
    let components = 0;

    if (hr !== null) {
      score += Math.min(1, Math.abs(hr - 72) / 120) * 0.4;
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

  private scoreArrhythmia(score: number): number {
    return Math.min(1, Math.max(0, score));
  }

  private generateFlags(
    categories: HealthRiskScore['categories'],
    vitals: VitalSignsResult,
    availability: {
      hasHr: boolean;
      hasArr: boolean;
    },
  ): string[] {
    const flags: string[] = [];
    const hr = vitals.heartRate.value;

    // Solo banderas desde pulso medido e irregularidad con evidencia.
    // NUNCA desde SpO2/PA/respiración (estimaciones experimentales).
    if (availability.hasArr) {
      if (categories.arrhythmia > 0.7) flags.push('ARRITMIA_SEVERA');
      else if (categories.arrhythmia > 0.4) flags.push('ARRITMIA_MODERADA');
    }

    if (availability.hasHr && categories.cardiovascular > 0.6) {
      flags.push('RITMO_FUERA_DE_RANGO_HABITUAL');
    }

    if (availability.hasHr && hr) {
      if (hr > 100) flags.push('TAQUICARDIA');
      else if (hr < 50) flags.push('BRADICARDIA');
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
        ['ARRITMIA_SEVERA'].includes(f),
      )
    ) return 'IMMEDIATE';

    if (
      overall > 0.5 ||
      flags.some(f =>
        ['ARRITMIA_MODERADA',
          'RITMO_FUERA_DE_RANGO_HABITUAL'].includes(f),
      )
    ) return 'SOON';

    if (overall > 0.2) return 'MONITOR';
    return 'NORMAL';
  }

  private generateRecommendations(flags: string[]): string[] {
    const recs: string[] = [];
    // Lenguaje de bienestar: informacion general + derivacion profesional.
    // Prohibido prescribir, ajustar medicacion o indicar pruebas clinicas
    // concretas. SpO2/PA no generan recomendaciones: son estimaciones
    // experimentales, no evidencia. Ante sintomas de alarma, emergencias.
    if (flags.includes('RITMO_FUERA_DE_RANGO_HABITUAL')) {
      recs.push('Pulso fuera del rango habitual de bienestar: descanse y consulte a un profesional de la salud si persiste');
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
    if (flags.length === 0) {
      recs.push('Su pulso medido se encuentra dentro de parámetros habituales de bienestar');
      recs.push('Mantenga hábitos cardiovasculares saludables, hidratación y ejercicio regular');
    }
    return recs;
  }
}

export const healthRiskAnalyzer = new HealthRiskAnalyzer();
