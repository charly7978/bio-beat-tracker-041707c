import React, { useState, useEffect, useCallback } from 'react';
import {
  Sliders,
  X,
  User,
  Activity,
  Shield,
  Check,
  AlertTriangle,
} from 'lucide-react';
import { CalibrationManager } from '@/modules/vital-signs/CalibrationManager';
import { supabase } from '@/integrations/supabase/client';
import { clearLocalMeasurements, decryptLocalMeasurements } from '@/hooks/useSaveMeasurement';
import { toast } from '@/hooks/use-toast';
import { createLogger } from '@/utils/logger';
import type { VitalSignsResult } from '@/modules/vital-signs/VitalSignsProcessor';

const log = createLogger('SettingsModal');

export interface HistoricalMeasurement {
  id: string;
  heart_rate: number;
  spo2: number;
  systolic: number;
  diastolic: number;
  arrhythmia_count: number;
  quality: number;
  measured_at: string;
  isCloud?: boolean;
}

interface ActiveUser {
  id: string;
  email?: string;
}

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  lastValidResults: VitalSignsResult | null;
  onCalibrationUpdated: (updatedSigns: Partial<VitalSignsResult>) => void;
}

export function SettingsModal({
  isOpen,
  onClose,
  lastValidResults,
  onCalibrationUpdated,
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<'profile' | 'calibration' | 'history' | 'account'>('profile');

  // Perfil antropométrico
  const [age, setAge] = useState<string>('35');
  const [height, setHeight] = useState<string>('172');
  const [weight, setWeight] = useState<string>('70');
  const [gender, setGender] = useState<'male' | 'female'>('male');

  // Calibración manual
  const [refSys, setRefSys] = useState<string>('');
  const [refDia, setRefDia] = useState<string>('');
  const [refSpo2, setRefSpo2] = useState<string>('');

  // Historial y cuenta
  const [history, setHistory] = useState<HistoricalMeasurement[]>([]);
  const [currentUser, setCurrentUser] = useState<ActiveUser | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');

  // Cargar datos antropométricos iniciales
  useEffect(() => {
    const profile = CalibrationManager.getInstance().getAnthropometric();
    if (profile) {
      setAge(profile.ageYears.toString());
      setHeight(profile.heightCm.toString());
      setWeight(profile.weightKg.toString());
      setGender(profile.isMale ? 'male' : 'female');
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    let formattedLocal: HistoricalMeasurement[] = [];
    try {
      const localData = await decryptLocalMeasurements();
      const typedLocal = localData as HistoricalMeasurement[];
      formattedLocal = typedLocal.map((m: HistoricalMeasurement) => ({
        ...m,
        isCloud: false,
      }));
    } catch (err) {
      log.error('Error fetching local history:', err);
      toast({
        title: 'Historial local no disponible',
        description: 'No se pudo acceder al historial local. Los datos se conservaron.',
        duration: 5000,
      });
    }

    let cloudData: HistoricalMeasurement[] = [];
    let cloudFetchFailed = false;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data, error } = await supabase
          .from('measurements')
          .select('*')
          .eq('user_id', user.id)
          .order('measured_at', { ascending: false });
        if (error) throw error;
        if (data) {
          cloudData = data.map((m: HistoricalMeasurement) => ({
            ...m,
            isCloud: true,
          }));
        }
      }
    } catch (err) {
      cloudFetchFailed = true;
      log.error('Error fetching cloud history:', err);
    }

    if (cloudFetchFailed && formattedLocal.length === 0) return;

    const combined = [...formattedLocal, ...cloudData].sort(
      (a, b) => new Date(b.measured_at).getTime() - new Date(a.measured_at).getTime()
    );
    setHistory(combined);
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setCurrentUser(session?.user ?? null);
      if (isOpen) void fetchHistory();
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setCurrentUser(session?.user ?? null);
      if (isOpen) void fetchHistory();
    });

    return () => subscription.unsubscribe();
  }, [fetchHistory, isOpen]);

  useEffect(() => {
    if (isOpen) {
      void fetchHistory();
    }
  }, [isOpen, fetchHistory]);

  const handleSaveProfile = useCallback(() => {
    const ageVal = parseInt(age, 10);
    const heightVal = parseInt(height, 10);
    const weightVal = parseInt(weight, 10);

    if (isNaN(ageVal) || ageVal < 1 || ageVal > 120) {
      toast({ title: 'Error', description: 'Por favor introduce una edad válida (1-120 años).' });
      return;
    }
    if (isNaN(heightVal) || heightVal < 50 || heightVal > 250) {
      toast({ title: 'Error', description: 'Por favor introduce una altura válida (50-250 cm).' });
      return;
    }
    if (isNaN(weightVal) || weightVal < 10 || weightVal > 300) {
      toast({ title: 'Error', description: 'Por favor introduce un peso válido (10-300 kg).' });
      return;
    }

    const profile = {
      ageYears: ageVal,
      heightCm: heightVal,
      weightKg: weightVal,
      isMale: gender === 'male',
    };
    CalibrationManager.getInstance().setAnthropometric(profile);

    toast({
      title: 'Perfil Guardado',
      description: 'El perfil fisiológico se aplicó al motor de presión arterial.',
      duration: 3000,
    });
  }, [age, height, weight, gender]);

  const handleCalibrateReference = useCallback(() => {
    const sysVal = parseInt(refSys, 10);
    const diaVal = parseInt(refDia, 10);
    const spo2Val = parseInt(refSpo2, 10);
    const calib = CalibrationManager.getInstance();

    let calibratedBP = false;
    let calibratedSpo2 = false;

    if (sysVal && diaVal) {
      if (sysVal < 70 || sysVal > 220 || diaVal < 40 || diaVal > 130) {
        toast({
          title: 'Valores fuera de rango',
          description: 'Sistólica: 70-220 mmHg, Diastólica: 40-130 mmHg.',
        });
        return;
      }

      const lastBP = lastValidResults?.bloodPressure.value;
      if (lastBP) {
        const sbpOffset = sysVal - lastBP.systolic;
        const dbpOffset = diaVal - lastBP.diastolic;

        calib.addProfile({
          id: `bp_${Date.now()}`,
          type: 'BP',
          deviceId: 'camera_ppg',
          modelName: 'PWA Engine v4',
          coefficients: { sbpOffset, dbpOffset },
          referenceValues: { systolic: sysVal, diastolic: diaVal },
          createdAt: Date.now(),
          expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
          method: 'cuff_reference',
        });
        calibratedBP = true;
      }
    }

    if (spo2Val) {
      if (spo2Val < 70 || spo2Val > 100) {
        toast({
          title: 'Valores fuera de rango',
          description: 'El valor de SpO2 debe situarse entre 70% y 100%.',
        });
        return;
      }

      const lastSpo2 = lastValidResults?.spo2.value;
      if (lastSpo2) {
        const spo2Offset = spo2Val - lastSpo2;

        calib.addProfile({
          id: `spo2_${Date.now()}`,
          type: 'SPO2',
          deviceId: 'camera_ppg',
          modelName: 'Beer-Lambert Camera Proxy',
          coefficients: { spo2Offset },
          referenceValues: { spo2: spo2Val },
          createdAt: Date.now(),
          expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
          method: 'oximeter_reference',
        });
        calibratedSpo2 = true;
      }
    }

    if (calibratedBP || calibratedSpo2) {
      setRefSys('');
      setRefDia('');
      setRefSpo2('');

      if (lastValidResults) {
        const updatedBP = calib.applyBloodPressureCalibration(
          lastValidResults.bloodPressure.value?.systolic ?? 120,
          lastValidResults.bloodPressure.value?.diastolic ?? 80
        );
        const activeSpo2 = calib.getActiveProfile('SPO2');
        const spo2Off = activeSpo2 ? (activeSpo2.coefficients.spo2Offset ?? 0) : 0;
        const updatedSpo2 = lastValidResults.spo2.value
          ? Math.min(99, Math.max(88, lastValidResults.spo2.value + spo2Off))
          : 98;

        onCalibrationUpdated({
          bloodPressure: {
            ...lastValidResults.bloodPressure,
            value: { systolic: updatedBP.systolic, diastolic: updatedBP.diastolic },
            status: 'VALID',
            calibration: calib.getCalibrationInfo('BP'),
          },
          spo2: {
            ...lastValidResults.spo2,
            value: updatedSpo2,
            status: 'VALID',
            calibration: calib.getCalibrationInfo('SPO2'),
          },
        });
      }

      toast({
        title: 'Calibración guardada',
        description: 'Los factores de calibración han sido actualizados y están vigentes.',
        duration: 3500,
      });
    } else {
      toast({
        title: 'Atención',
        description: 'Introduce al menos un valor de referencia para calibrar.',
      });
    }
  }, [refSys, refDia, refSpo2, lastValidResults, onCalibrationUpdated]);

  const handleClearHistory = useCallback(async () => {
    if (!window.confirm('¿Deseas vaciar el historial local de este dispositivo?')) return;
    try {
      await clearLocalMeasurements();
      await fetchHistory();
      toast({ title: 'Historial eliminado', description: 'El historial local ha sido limpiado.' });
    } catch (err) {
      log.error('Error clearing local history:', err);
      toast({
        title: 'Error al limpiar',
        description: 'No se pudo vaciar el historial local.',
      });
    }
  }, [fetchHistory]);

  const handleExportCSV = useCallback(() => {
    if (history.length === 0) {
      toast({ title: 'Sin datos', description: 'No hay mediciones para exportar.' });
      return;
    }
    let csvContent = 'data:text/csv;charset=utf-8,';
    csvContent += 'Fecha,Origen,Pulso (bpm),SpO2 (%),Presion Sistolica (mmHg),Presion Diastolica (mmHg),Latidos Irregulares\n';

    history.forEach((m) => {
      const date = new Date(m.measured_at).toISOString();
      const origin = m.isCloud ? 'Nube' : 'Local';
      const hr = m.heart_rate ?? '';
      const spo2 = m.spo2 ?? '';
      const sys = m.systolic ?? '';
      const dia = m.diastolic ?? '';
      const arr = m.arrhythmia_count ?? 0;
      csvContent += `"${date}","${origin}",${hr},${spo2},${sys},${dia},${arr}\n`;
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `historial_bio_beat_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [history]);

  const handleAuth = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      toast({ title: 'Campos requeridos', description: 'Ingresa correo y contraseña.' });
      return;
    }
    setAuthLoading(true);
    try {
      if (authMode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        toast({ title: 'Bienvenido', description: 'Sesión iniciada correctamente.' });
      } else {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        toast({
          title: 'Registro exitoso',
          description: 'Revisa tu correo para confirmar la cuenta.',
          duration: 6000,
        });
      }
      setEmail('');
      setPassword('');
    } catch (error: unknown) {
      const err = error as Error;
      toast({
        title: 'Error de autenticación',
        description: err.message || 'No se pudo completar la operación.',
      });
    } finally {
      setAuthLoading(false);
    }
  }, [email, password, authMode]);

  const handleSignOut = useCallback(async () => {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      toast({ title: 'Sesión cerrada', description: 'Se ha cerrado la sesión exitosamente.' });
    } catch (error: unknown) {
      const err = error as Error;
      toast({ title: 'Error', description: err.message || 'Error al cerrar sesión.' });
    }
  }, []);

  if (!isOpen) return null;

  return (
    <div className="instrument-dialog-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="instrument-dialog bg-black/95 border border-zinc-900/80 rounded-2xl max-w-sm w-[92%] shadow-2xl overflow-hidden flex flex-col max-h-[85vh] animate-in zoom-in-95 duration-200">
        
        {/* Header */}
        <div className="instrument-dialog-header px-4 pt-3 bg-gradient-to-r from-slate-900 to-slate-950 border-b border-zinc-900 flex flex-col">
          <div className="flex items-center justify-between pb-2">
            <div className="flex items-center gap-2">
              <Sliders className="w-5 h-5 text-emerald-400" />
              <div>
                <h3 className="text-white text-sm font-bold tracking-wide uppercase">Ajustes del Sistema</h3>
                <p className="text-zinc-500 text-[8px] font-medium tracking-wider uppercase">Calibración y Gestión</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-full bg-zinc-950 hover:bg-zinc-900 text-zinc-400 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Tabs */}
          <div className="flex border-t border-zinc-950 text-[10px] font-bold">
            <button
              onClick={() => setActiveTab('profile')}
              className={`flex-1 py-2 text-center transition-colors border-b-2 ${activeTab === 'profile' ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5' : 'border-transparent text-zinc-500 hover:text-slate-300'}`}
            >
              PERFIL
            </button>
            <button
              onClick={() => setActiveTab('calibration')}
              className={`flex-1 py-2 text-center transition-colors border-b-2 ${activeTab === 'calibration' ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5' : 'border-transparent text-zinc-500 hover:text-slate-300'}`}
            >
              CALIBRACIÓN
            </button>
            <button
              onClick={() => setActiveTab('history')}
              className={`flex-1 py-2 text-center transition-colors border-b-2 ${activeTab === 'history' ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5' : 'border-transparent text-zinc-500 hover:text-slate-300'}`}
            >
              HISTORIAL ({history.length})
            </button>
            <button
              onClick={() => setActiveTab('account')}
              className={`flex-1 py-2 text-center transition-colors border-b-2 ${activeTab === 'account' ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5' : 'border-transparent text-zinc-500 hover:text-slate-300'}`}
            >
              NUBE
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">

          {/* TAB: PERFIL */}
          {activeTab === 'profile' && (
            <div className="space-y-4 animate-in fade-in duration-200">
              <div className="space-y-3">
                <div className="flex items-center gap-1.5 text-zinc-400 text-[10px] font-bold uppercase tracking-wider">
                  <User className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Perfil Fisiológico Antropométrico</span>
                </div>

                <div className="bg-zinc-950/60 border border-zinc-900/50 rounded-xl p-3.5 space-y-3.5">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Edad (años)</label>
                      <input
                        type="number"
                        value={age}
                        onChange={(e) => setAge(e.target.value)}
                        className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors"
                        placeholder="35"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Sexo Biológico</label>
                      <div className="grid grid-cols-2 gap-1 bg-black p-0.5 rounded-lg border border-zinc-900">
                        <button
                          type="button"
                          onClick={() => setGender('male')}
                          className={`py-1 text-[10px] font-bold rounded ${gender === 'male' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'text-zinc-500 hover:text-white'}`}
                        >
                          MASC
                        </button>
                        <button
                          type="button"
                          onClick={() => setGender('female')}
                          className={`py-1 text-[10px] font-bold rounded ${gender === 'female' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'text-zinc-500 hover:text-white'}`}
                        >
                          FEM
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Altura (cm)</label>
                      <input
                        type="number"
                        value={height}
                        onChange={(e) => setHeight(e.target.value)}
                        className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors"
                        placeholder="172"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Peso (kg)</label>
                      <input
                        type="number"
                        value={weight}
                        onChange={(e) => setWeight(e.target.value)}
                        className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors"
                        placeholder="70"
                      />
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={handleSaveProfile}
                    className="w-full py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-[11px] transition-colors flex items-center justify-center gap-1.5"
                  >
                    <Check className="w-3.5 h-3.5" /> GUARDAR PERFIL
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* TAB: CALIBRACIÓN */}
          {activeTab === 'calibration' && (
            <div className="space-y-4 animate-in fade-in duration-200">
              <div className="space-y-3">
                <div className="flex items-center gap-1.5 text-zinc-400 text-[10px] font-bold uppercase tracking-wider">
                  <Activity className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Calibración Cruzada con Dispositivo Clínico</span>
                </div>

                <div className="bg-zinc-950/60 border border-zinc-900/50 rounded-xl p-3.5 space-y-3.5">
                  {lastValidResults ? (
                    <>
                      <div className="bg-black/60 rounded-lg p-2.5 border border-zinc-900/40 text-[10px] space-y-1">
                        <span className="text-zinc-500 font-semibold block uppercase">Última lectura:</span>
                        <div className="flex justify-between text-white font-bold">
                          <span>
                            PA: {lastValidResults.bloodPressure.value ? `${Math.round(lastValidResults.bloodPressure.value.systolic)}/${Math.round(lastValidResults.bloodPressure.value.diastolic)} mmHg` : 'No detectada'}
                          </span>
                          <span>
                            SpO₂: {lastValidResults.spo2.value ? `${Math.round(lastValidResults.spo2.value)}%` : 'No detectado'}
                          </span>
                        </div>
                      </div>

                      <div className="space-y-2.5">
                        <div className="grid grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Ref. Sistólica (mmHg)</label>
                            <input
                              type="number"
                              value={refSys}
                              onChange={(e) => setRefSys(e.target.value)}
                              className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors"
                              placeholder="120"
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Ref. Diastólica (mmHg)</label>
                            <input
                              type="number"
                              value={refDia}
                              onChange={(e) => setRefDia(e.target.value)}
                              className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors"
                              placeholder="80"
                            />
                          </div>
                        </div>

                        <div className="space-y-1">
                          <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Ref. SpO₂ (%)</label>
                          <input
                            type="number"
                            value={refSpo2}
                            onChange={(e) => setRefSpo2(e.target.value)}
                            className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors"
                            placeholder="98"
                          />
                        </div>

                        <button
                          type="button"
                          onClick={handleCalibrateReference}
                          className="w-full py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-[11px] transition-colors flex items-center justify-center gap-1.5"
                        >
                          <Activity className="w-3.5 h-3.5" /> CALIBRAR DISPOSITIVO
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="text-center py-4 space-y-2">
                      <AlertTriangle className="w-6 h-6 text-amber-500 mx-auto" />
                      <p className="text-zinc-400 text-[10px] font-semibold leading-relaxed">
                        Completa una medición previa para calibrar con tus valores de referencia.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Estado de Calibraciones */}
              <div className="space-y-3">
                <div className="flex items-center gap-1.5 text-zinc-400 text-[10px] font-bold uppercase tracking-wider">
                  <Shield className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Calibraciones Activas</span>
                </div>

                <div className="bg-zinc-950/60 border border-zinc-900/50 rounded-xl p-3.5 space-y-2 text-[10px] font-semibold text-zinc-400">
                  <div className="flex justify-between items-center py-1 border-b border-zinc-900/50">
                    <span>Presión Arterial (BP)</span>
                    {CalibrationManager.getInstance().getCalibrationInfo('BP').available ? (
                      <span className="text-emerald-400 font-bold uppercase">Activo (Válido)</span>
                    ) : (
                      <span className="text-slate-600 uppercase">Sin calibrar</span>
                    )}
                  </div>
                  <div className="flex justify-between items-center py-1">
                    <span>Oxígeno en Sangre (SpO2)</span>
                    {CalibrationManager.getInstance().getCalibrationInfo('SPO2').available ? (
                      <span className="text-emerald-400 font-bold uppercase">Activo (Válido)</span>
                    ) : (
                      <span className="text-slate-600 uppercase">Sin calibrar</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB: HISTORIAL */}
          {activeTab === 'history' && (
            <div className="space-y-4 animate-in fade-in duration-200">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleExportCSV}
                  className="flex-1 py-2 rounded-xl bg-zinc-950 border border-zinc-900 hover:bg-zinc-900 text-white font-bold text-xs transition-all flex items-center justify-center gap-2"
                >
                  <Activity className="w-4 h-4 text-cyan-400" /> EXPORTAR CSV
                </button>
                <button
                  type="button"
                  onClick={handleClearHistory}
                  className="px-4 py-2 rounded-xl bg-red-950/20 border border-red-900/40 text-red-400 hover:bg-red-950/40 font-bold text-xs transition-all"
                >
                  LIMPIAR
                </button>
              </div>

              <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
                {history.length > 0 ? (
                  history.map((m: HistoricalMeasurement) => {
                    const dateStr = new Date(m.measured_at).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    });
                    return (
                      <div key={m.id} className="bg-zinc-950/60 border border-zinc-900/40 rounded-xl p-3 space-y-2 relative">
                        <div className="flex justify-between items-center">
                          <span className="text-[10px] text-zinc-500 font-bold uppercase">{dateStr}</span>
                          {m.isCloud ? (
                            <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-400">NUBE</span>
                          ) : (
                            <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-zinc-900 text-zinc-400">LOCAL</span>
                          )}
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-center">
                          <div className="bg-black/40 rounded-lg py-1 border border-zinc-950">
                            <span className="text-zinc-500 text-[8px] block font-bold">PULSO</span>
                            <span className="text-white text-xs font-bold">{m.heart_rate || '--'} <span className="text-[8px] text-zinc-400">bpm</span></span>
                          </div>
                          <div className="bg-black/40 rounded-lg py-1 border border-zinc-950">
                            <span className="text-zinc-500 text-[8px] block font-bold">SpO₂</span>
                            <span className="text-white text-xs font-bold">{m.spo2 || '--'}<span className="text-[8px] text-zinc-400">%</span></span>
                          </div>
                          <div className="bg-black/40 rounded-lg py-1 border border-zinc-950">
                            <span className="text-zinc-500 text-[8px] block font-bold">PRESIÓN</span>
                            <span className="text-white text-xs font-bold">
                              {m.systolic && m.diastolic ? `${m.systolic}/${m.diastolic}` : '--'}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div className="text-center py-10 space-y-2 border border-dashed border-zinc-900 rounded-xl">
                    <Activity className="w-8 h-8 text-slate-700 mx-auto animate-pulse" />
                    <p className="text-zinc-500 text-[10px] font-semibold">No hay mediciones guardadas en este dispositivo.</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB: CUENTA Y SINCRONIZACIÓN */}
          {activeTab === 'account' && (
            <div className="space-y-4 animate-in fade-in duration-200">
              {currentUser ? (
                <div className="bg-zinc-950/60 border border-zinc-900/50 rounded-xl p-4 space-y-4 text-center">
                  <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto">
                    <Check className="w-6 h-6 text-emerald-400" />
                  </div>
                  <div className="space-y-1">
                    <h4 className="text-white text-xs font-bold">SESIÓN ACTIVA</h4>
                    <p className="text-zinc-400 text-[10px] font-mono">{currentUser.email}</p>
                  </div>
                  <p className="text-zinc-500 text-[9px] leading-relaxed">
                    Tus signos vitales se sincronizan de forma segura con tu cuenta de usuario.
                  </p>
                  <button
                    type="button"
                    onClick={handleSignOut}
                    className="w-full py-2 rounded-xl bg-red-950/20 border border-red-900/40 text-red-400 hover:bg-red-950/40 font-bold text-xs transition-all"
                  >
                    CERRAR SESIÓN
                  </button>
                </div>
              ) : (
                <form onSubmit={handleAuth} className="bg-zinc-950/60 border border-zinc-900/50 rounded-xl p-4 space-y-4">
                  <div className="text-center space-y-1 pb-2">
                    <h4 className="text-white text-xs font-bold uppercase">Sincronización en la Nube</h4>
                    <p className="text-zinc-500 text-[9px] font-medium leading-relaxed">
                      Inicia sesión para sincronizar tu historial de mediciones entre dispositivos.
                    </p>
                  </div>

                  <div className="space-y-2.5">
                    <div className="space-y-1">
                      <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Correo Electrónico</label>
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors"
                        placeholder="tu@correo.com"
                        required
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wide">Contraseña</label>
                      <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        className="w-full bg-black border border-zinc-900 rounded-lg px-2.5 py-1.5 text-white text-xs font-semibold focus:outline-none focus:border-emerald-500 transition-colors"
                        placeholder="••••••••"
                        required
                      />
                    </div>
                  </div>

                  <div className="pt-2 space-y-3">
                    <button
                      type="submit"
                      disabled={authLoading}
                      className="w-full py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-indigo-600 hover:from-emerald-500 hover:to-indigo-500 text-white font-bold text-xs tracking-wider transition-all disabled:opacity-50"
                    >
                      {authLoading ? 'Procesando...' : (authMode === 'signin' ? 'INICIAR SESIÓN' : 'CREAR CUENTA')}
                    </button>

                    <div className="text-center">
                      <button
                        type="button"
                        onClick={() => setAuthMode((prev) => (prev === 'signin' ? 'signup' : 'signin'))}
                        className="text-emerald-400 hover:text-emerald-300 text-[10px] font-bold"
                      >
                        {authMode === 'signin' ? '¿No tienes cuenta? Regístrate aquí' : '¿Ya tienes cuenta? Inicia sesión'}
                      </button>
                    </div>
                  </div>
                </form>
              )}
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

