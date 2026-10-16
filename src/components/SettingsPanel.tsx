/**
 * PANEL DE AJUSTES Y CALIBRACIÓN — perfil fisiológico, calibración cruzada,
 * historial local/nube y sincronización de cuenta.
 * El estado y los handlers viven en Index (orquestador); el tab activo es local.
 */
import { useState } from 'react';
import { Activity, AlertTriangle, Check, Shield, Sliders, User, X } from 'lucide-react';
import { CalibrationManager } from '@/modules/vital-signs/CalibrationManager';
import type { VitalSignsResult } from '@/modules/vital-signs/VitalSignsProcessor';

export interface ActiveUser {
  id: string;
  email?: string;
}

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

type SettingsTab = 'profile' | 'calibration' | 'history' | 'account';

interface SettingsPanelProps {
  onClose: () => void;
  age: string;
  setAge: (v: string) => void;
  gender: 'male' | 'female';
  setGender: (v: 'male' | 'female') => void;
  height: string;
  setHeight: (v: string) => void;
  weight: string;
  setWeight: (v: string) => void;
  handleSaveProfile: () => void;
  lastValidResults: VitalSignsResult | null;
  refSys: string;
  setRefSys: (v: string) => void;
  refDia: string;
  setRefDia: (v: string) => void;
  refSpo2: string;
  setRefSpo2: (v: string) => void;
  handleCalibrateReference: () => void;
  history: HistoricalMeasurement[];
  handleExportCSV: () => void;
  handleClearHistory: () => void;
  currentUser: ActiveUser | null;
  email: string;
  setEmail: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  authLoading: boolean;
  authMode: 'signin' | 'signup';
  setAuthMode: React.Dispatch<React.SetStateAction<'signin' | 'signup'>>;
  handleAuth: (e: React.FormEvent) => void;
  handleSignOut: () => void;
}

export function SettingsPanel(props: SettingsPanelProps) {
  const {
    onClose,
    age, setAge,
    gender, setGender,
    height, setHeight,
    weight, setWeight,
    handleSaveProfile,
    lastValidResults,
    refSys, setRefSys,
    refDia, setRefDia,
    refSpo2, setRefSpo2,
    handleCalibrateReference,
    history,
    handleExportCSV,
    handleClearHistory,
    currentUser,
    email, setEmail,
    password, setPassword,
    authLoading,
    authMode, setAuthMode,
    handleAuth,
    handleSignOut,
  } = props;

  const [activeTab, setActiveTab] = useState<SettingsTab>('profile');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md animate-fade-in p-4">
      <div className="glass-panel border border-white/15 rounded-3xl max-w-sm w-full shadow-2xl overflow-hidden flex flex-col max-h-[85vh] animate-in zoom-in-95 duration-200">

        {/* Header */}
        <div className="px-5 pt-4 bg-gradient-to-b from-white/5 to-transparent border-b border-white/10 flex flex-col">
          <div className="flex items-center justify-between pb-3">
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-2xl bg-emerald-500/10 border border-emerald-500/20">
                <Sliders className="w-4 h-4 text-emerald-400" />
              </div>
              <div>
                <h3 className="text-white text-sm font-bold font-heading tracking-wide uppercase">Ajustes del Sistema</h3>
                <p className="text-zinc-400 text-[8px] font-mono tracking-wider uppercase">Monitorización y calibración clínica</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Tabs Selector */}
          <div className="flex gap-1 p-1 bg-black/40 rounded-2xl border border-white/5 text-[9px] font-bold font-mono mb-2">
            <button
              onClick={() => setActiveTab('profile')}
              className={`flex-1 py-1.5 px-2 text-center rounded-xl transition-all duration-200 ${
                activeTab === 'profile'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 shadow-md'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              PERFIL
            </button>
            <button
              onClick={() => setActiveTab('calibration')}
              className={`flex-1 py-1.5 px-2 text-center rounded-xl transition-all duration-200 ${
                activeTab === 'calibration'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 shadow-md'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              CALIBRACIÓN
            </button>
            <button
              onClick={() => setActiveTab('history')}
              className={`flex-1 py-1.5 px-2 text-center rounded-xl transition-all duration-200 ${
                activeTab === 'history'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 shadow-md'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              HISTORIAL
            </button>
            <button
              onClick={() => setActiveTab('account')}
              className={`flex-1 py-1.5 px-2 text-center rounded-xl transition-all duration-200 ${
                activeTab === 'account'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 shadow-md'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              SYNC
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">

          {/* TAB 1: PERFIL */}
          {activeTab === 'profile' && (
            <div className="space-y-4 animate-in fade-in duration-200">
              {/* Sección 1: Perfil Fisiológico */}
              <div className="space-y-3">
                <div className="flex items-center gap-1.5 text-zinc-400 text-[10px] font-bold uppercase tracking-wider">
                  <User className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Perfil Fisiológico (PA Neuronal)</span>
                </div>

                <div className="bg-zinc-950/60 border border-zinc-900/50 rounded-xl p-3.5 space-y-3.5">
                  {/* Edad y Género */}
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

                  {/* Altura y Peso */}
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

          {/* TAB 1b: CALIBRACIÓN */}
          {activeTab === 'calibration' && (
            <div className="space-y-4 animate-in fade-in duration-200">
              {/* Sección 2: Calibración Cruzada */}
              <div className="space-y-3">
                <div className="flex items-center gap-1.5 text-zinc-400 text-[10px] font-bold uppercase tracking-wider">
                  <Activity className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Calibración con Dispositivo Médico</span>
                </div>

                <div className="bg-zinc-950/60 border border-zinc-900/50 rounded-xl p-3.5 space-y-3.5">
                  {lastValidResults ? (
                    <>
                      <div className="bg-black/60 rounded-lg p-2.5 border border-zinc-900/40 text-[10px] space-y-1">
                        <span className="text-zinc-500 font-semibold block uppercase">Última medición registrada:</span>
                        <div className="flex justify-between text-white font-bold">
                          <span>PA: {lastValidResults.bloodPressure.value ? `${Math.round(lastValidResults.bloodPressure.value.systolic)}/${Math.round(lastValidResults.bloodPressure.value.diastolic)} mmHg` : 'No detectada'}</span>
                          <span>SpO₂: {lastValidResults.spo2.value ? `${Math.round(lastValidResults.spo2.value)}%` : 'No detectado'}</span>
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
                        Realiza al menos una medición completa para poder calibrar los sensores ópticos con tus valores de referencia.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Sección 3: Estado de Calibraciones */}
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

          {/* TAB 2: HISTORIAL DE MEDICIONES */}
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
                      minute: '2-digit'
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
                            <span className="text-zinc-500 text-[8px] block font-bold">SpO₂ <span className="text-amber-400/80">·EXP</span></span>
                            <span className="text-white text-xs font-bold">{m.spo2 || '--'}<span className="text-[8px] text-zinc-400">%</span></span>
                          </div>
                          <div className="bg-black/40 rounded-lg py-1 border border-zinc-950">
                            <span className="text-zinc-500 text-[8px] block font-bold">PRESIÓN <span className="text-amber-400/80">·EXP</span></span>
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
                    <p className="text-zinc-500 text-[10px] font-semibold">Aún no hay mediciones guardadas en este dispositivo.</p>
                  </div>
                )}
                {history.length > 0 && (
                  <p className="text-zinc-600 text-[8px] font-mono leading-tight px-1">
                    ·EXP = estimación experimental de bienestar, no medición clínica. «--» = no disponible (sin señal suficiente o sin referencia vigente).
                  </p>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: SINCRONIZACIÓN EN LA NUBE */}
          {activeTab === 'account' && (
            <div className="space-y-4 animate-in fade-in duration-200">
              {currentUser ? (
                <div className="bg-zinc-950/60 border border-zinc-900/50 rounded-xl p-4 space-y-4 text-center">
                  <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto">
                    <Check className="w-6 h-6 text-emerald-400" />
                  </div>
                  <div className="space-y-1">
                    <h4 className="text-white text-xs font-bold">SESIÓN INICIADA</h4>
                    <p className="text-zinc-400 text-[10px] font-mono">{currentUser.email}</p>
                  </div>
                  <p className="text-zinc-500 text-[9px] leading-relaxed">
                    Tus signos vitales se guardarán automáticamente en la nube y se sincronizarán en todos tus dispositivos.
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
                      Crea una cuenta para guardar tu historial en internet de forma permanente y segura.
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
                      {authLoading ? "Procesando..." : (authMode === 'signin' ? "INICIAR SESIÓN" : "CREAR CUENTA")}
                    </button>

                    <div className="text-center">
                      <button
                        type="button"
                        onClick={() => setAuthMode(prev => prev === 'signin' ? 'signup' : 'signin')}
                        className="text-emerald-400 hover:text-emerald-300 text-[10px] font-bold"
                      >
                        {authMode === 'signin' ? "¿No tienes cuenta? Regístrate aquí" : "¿Ya tienes cuenta? Inicia sesión"}
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
