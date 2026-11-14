#!/usr/bin/env python3
"""Train a subject-separated, paired PPG→ECG research model on BIDMC 1.0.0.

No generated training waveforms, peak alignment, time warping, or target leakage.
The exported network runs in the existing browser signal-processing worker.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.request import urlopen

os.environ.setdefault('OPENBLAS_NUM_THREADS', '2')
os.environ.setdefault('OMP_NUM_THREADS', '2')
import numpy as np
from scipy.signal import lfilter, resample_poly
from sklearn.neural_network import MLPRegressor
from sklearn.linear_model import Ridge
import scipy
import sklearn

ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://physionet.org/files/bidmc/1.0.0/'
FS, INPUT, START, OUTPUT, WARMUP = 30, 60, 22, 15, 150
SEED = 20261114


def fetch(cache: Path, name: str) -> bytes:
    path = cache / name
    if not path.exists():
        with urlopen(BASE + name, timeout=90) as response:
            data = response.read()
        path.write_bytes(data)
    return path.read_bytes()


def bessel_filter(values: np.ndarray) -> np.ndarray:
    """Exact coefficient convention of src/.../shared/BesselFilter.ts."""
    result = np.asarray(values, dtype=np.float64)
    for cutoff, highpass in [(0.5, True), (12.0, False)]:
        k = np.tan(np.pi * cutoff / FS)
        for zeta in [1.0440, 1.6110]:
            norm = 1 / (1 + zeta * k + k * k)
            b = np.array([1., -2., 1.]) * norm if highpass else np.array([k * k, 2 * k * k, k * k]) * norm
            a = [1., 2 * (k * k - 1) * norm, (1 - zeta * k + k * k) * norm]
            result = lfilter(b, a, result)
    return result


def load_record(cache: Path, name: str, checksums: dict[str, str]):
    header_bytes, data_bytes = fetch(cache, name + '.hea'), fetch(cache, name + '.dat')
    for filename, content in [(name + '.hea', header_bytes), (name + '.dat', data_bytes)]:
        digest = hashlib.sha256(content).hexdigest()
        if checksums.get(filename) != digest:
            raise ValueError(f'Published SHA256 mismatch for {filename}')
    header = header_bytes.decode()
    lines = header.splitlines()
    n_channels, record_fs, n_samples = map(int, lines[0].split()[1:4])
    raw = np.frombuffer(data_bytes, dtype='<i2').reshape(-1, n_channels)
    if raw.shape[0] != n_samples or record_fs != 125:
        raise ValueError(f'Unexpected shape or sample rate: {name}')
    channels = {}
    for index, line in enumerate(lines[1:1 + n_channels]):
        fields = line.split()
        if fields[1] != '16':
            raise ValueError(f'Unsupported WFDB storage format {fields[1]}')
        gain_match = re.fullmatch(r'([0-9.eE+\-]+)(?:\((-?\d+)\))?/\S+', fields[2])
        if gain_match is None:
            raise ValueError(f'Unsupported gain descriptor {fields[2]}')
        gain = float(gain_match.group(1))
        baseline = int(gain_match.group(2) or fields[4])
        label = ' '.join(fields[8:]).rstrip(', ').strip()
        channel = (raw[:, index].astype(np.float64) - baseline) / gain
        channel[raw[:, index] == -32768] = np.nan
        channels[label] = channel
    if 'PLETH' not in channels or 'II' not in channels:
        raise ValueError(f'No paired PLETH/lead-II ECG in {name}: {list(channels)}')
    source = re.search(r'/matched/(s\d+)/', header)
    if source is None:
        raise ValueError(f'Missing source-subject identifier: {name}')
    input_times = np.arange(n_samples) / record_fs
    times = np.arange(int((n_samples - 1) / record_fs * FS) + 1) / FS
    pleth = np.interp(times, input_times, channels['PLETH'])
    ecg = resample_poly(channels['II'], 6, 25)[:len(times)]
    filtered = bessel_filter(pleth)
    inputs, targets = [], []
    for start in range(WARMUP, len(times) - INPUT + 1, OUTPUT):
        x, y = filtered[start:start + INPUT], ecg[start:start + INPUT]
        if not np.isfinite(x).all() or not np.isfinite(y).all():
            continue
        x_std, y_std = x.std(), y.std()
        if x_std <= np.finfo(float).eps or y_std <= np.finfo(float).eps:
            continue
        inputs.append((x - x.mean()) / x_std)
        targets.append(((y - y.mean()) / y_std)[START:START + OUTPUT])
    return name, source.group(1), np.asarray(inputs, np.float32), np.asarray(targets, np.float32), filtered, pleth


def metrics(y: np.ndarray, predicted: np.ndarray):
    truth, guess = y.ravel().astype(float), predicted.ravel().astype(float)
    rmse = np.sqrt(np.mean((truth - guess) ** 2))
    baseline = np.sqrt(np.mean(truth ** 2))
    correlation = float(np.corrcoef(truth, guess)[0, 1]) if guess.std() else 0.
    per_window = []
    for target, output in zip(y, predicted):
        if target.std() > 0 and output.std() > 0:
            per_window.append(float(np.corrcoef(target, output)[0, 1]))
    return {
        'rmse': float(rmse), 'zeroBaselineRmse': float(baseline),
        'rmseImprovementPct': float((1 - rmse / baseline) * 100),
        'pearson': correlation, 'medianWindowPearson': float(np.median(per_window)),
        'windows': int(len(y)), 'samples': int(y.size),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=ROOT / 'work/ppg-ecg-data')
    parser.add_argument('--output', type=Path, default=ROOT / 'src/lib/models/ppgToEcg.weights.json')
    parser.add_argument('--epochs', type=int, default=80)
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    checksums = {}
    for line in fetch(args.cache, 'SHA256SUMS.txt').decode().splitlines():
        parts = line.split()
        if len(parts) == 2:
            checksums[parts[1].lstrip('*')] = parts[0]
    fetch(args.cache, 'LICENSE')
    names = [f'bidmc{number:02}' for number in range(1, 54)]
    start_time = time.monotonic()
    with ThreadPoolExecutor(max_workers=8) as executor:
        records = list(executor.map(lambda name: load_record(args.cache, name, checksums), names))
    print(f'Loaded {len(records)} paired records in {time.monotonic()-start_time:.1f}s', flush=True)
    subjects = sorted({record[1] for record in records})
    rng = np.random.default_rng(SEED)
    shuffled = [subjects[i] for i in rng.permutation(len(subjects))]
    n_test = max(1, round(len(subjects) * .17))
    n_val = max(1, round(len(subjects) * .17))
    split = {'train': sorted(shuffled[n_test + n_val:]), 'validation': sorted(shuffled[n_test:n_test + n_val]), 'test': sorted(shuffled[:n_test])}
    arrays, split_records = {}, {}
    for name, identifiers in split.items():
        selected = [record for record in records if record[1] in identifiers]
        split_records[name] = [record[0] for record in selected]
        arrays[name] = (np.concatenate([record[2] for record in selected]), np.concatenate([record[3] for record in selected]))
        print(f'{name}: {len(identifiers)} subjects, {len(selected)} records, {len(arrays[name][0])} windows', flush=True)
    best, best_loss, best_epoch, history, comparison = None, float('inf'), 0, [], []
    selected_name = ''
    for alpha in [1., 10., 100., 1000.]:
        candidate = Ridge(alpha=alpha).fit(*arrays['train'])
        val_loss = float(np.mean((candidate.predict(arrays['validation'][0]) - arrays['validation'][1]) ** 2))
        name = f'ridge-alpha-{alpha:g}'
        comparison.append({'name': name, 'validationMse': val_loss, 'selectedEpoch': 1, 'epochsRun': 1})
        print(f'{name} validationMse={val_loss:.6f}', flush=True)
        if val_loss < best_loss:
            best, best_loss, best_epoch, selected_name = candidate, val_loss, 1, name
            history = []
    for hidden, alpha in [((128, 64), .001), ((32,), 1.), ((32,), 10.), ((128, 64), 100.)]:
        model = MLPRegressor(hidden_layer_sizes=hidden, activation='tanh', solver='adam',
                             alpha=alpha, batch_size=256, learning_rate_init=.0007,
                             max_iter=1, shuffle=True, random_state=SEED, early_stopping=False)
        candidate_best, candidate_loss, candidate_epoch, stale, candidate_history = None, float('inf'), 0, 0, []
        name = f'mlp-{"-".join(map(str, hidden))}-alpha-{alpha:g}'
        for epoch in range(1, args.epochs + 1):
            model.partial_fit(*arrays['train'])
            val_loss = float(np.mean((model.predict(arrays['validation'][0]) - arrays['validation'][1]) ** 2))
            candidate_history.append({'epoch': epoch, 'trainLoss': float(model.loss_), 'validationMse': val_loss})
            if val_loss < candidate_loss - 1e-5:
                candidate_best, candidate_loss, candidate_epoch, stale = copy.deepcopy(model), val_loss, epoch, 0
            else:
                stale += 1
            if epoch == 1 or epoch % 10 == 0:
                print(f'{name} epoch {epoch:03} validationMse={val_loss:.6f} best={candidate_epoch}', flush=True)
            if stale >= 12 and epoch >= 25:
                break
        comparison.append({'name': name, 'validationMse': candidate_loss, 'selectedEpoch': candidate_epoch, 'epochsRun': len(candidate_history), 'history': candidate_history})
        if candidate_loss < best_loss:
            best, best_loss, best_epoch, selected_name = candidate_best, candidate_loss, candidate_epoch, name
            history = candidate_history
    assert best is not None
    # Held-out test is accessed only after validation-based checkpoint selection.
    evaluation = {name: metrics(targets, best.predict(inputs)) for name, (inputs, targets) in arrays.items()}
    per_record = {}
    for record in records:
        if record[0] in split_records['test']:
            per_record[record[0]] = metrics(record[3], best.predict(record[2]))
    parity_record = next(record for record in records if record[0] in split_records['test'])
    parity_input = parity_record[4][WARMUP:WARMUP + INPUT]
    normalized = (parity_input - parity_input.mean()) / parity_input.std()
    parity_expected = best.predict(normalized.reshape(1, -1))[0]
    layers = []
    if isinstance(best, Ridge):
        layers = [{'weights': best.coef_.T.astype(float).tolist(), 'bias': best.intercept_.astype(float).tolist(), 'activation': 'linear'}]
    else:
        for index, (weights, bias) in enumerate(zip(best.coefs_, best.intercepts_)):
            layers.append({'weights': weights.astype(float).tolist(), 'bias': bias.astype(float).tolist(), 'activation': 'tanh' if index < len(best.coefs_) - 1 else 'linear'})
    model_json = {
        'version': 1, 'modelId': 'bidmc-ppg-to-ecg-30hz-20261114',
        'sampleRate': FS, 'inputLength': INPUT, 'outputStart': START, 'outputLength': OUTPUT,
        'filterWarmupSamples': WARMUP,
        'normalization': 'window-zscore-population',
        'inputPreprocessing': {'source': 'rawValue', 'resampling': 'linear', 'filter': 'BesselFilter', 'lowCutHz': .5, 'highCutHz': 12., 'zeta': [1.044, 1.611]},
        'target': {'channel': 'ECG lead II', 'normalization': 'context-zscore-population', 'unit': 'relative', 'bandlimitHz': 15, 'sampling': 'scipy-resample-poly-6-25', 'peakAlignment': False},
        'layers': layers,
        'training': {
            'dataset': 'BIDMC PPG and Respiration Dataset', 'datasetVersion': '1.0.0',
            'datasetUrl': 'https://physionet.org/content/bidmc/1.0.0/',
            'datasetDoi': '10.13026/C2208R', 'license': 'ODC-By-1.0',
            'licenseUrl': 'https://physionet.org/content/bidmc/view-license/1.0.0/',
            'citation': 'Pimentel et al., Towards a Robust Estimation of Respiratory Rate from Pulse Oximeters, IEEE TBME 64(8), 1914–1923, DOI 10.1109/TBME.2016.2613124',
            'seed': SEED, 'subjectCount': len(subjects), 'recordCount': len(records),
            'subjectSplits': split, 'recordSplits': split_records,
            'epochsRun': len(history), 'selectedEpoch': best_epoch,
            'selectedCandidate': selected_name, 'candidateComparison': comparison,
            'selectionCriterion': 'minimum validation MSE on disjoint subjects',
            'history': history, 'metrics': evaluation, 'heldOutPerRecord': per_record,
            'checksums': {name + ext: checksums[name + ext] for name in names for ext in ['.hea', '.dat']},
            'software': {'numpy': np.__version__, 'scipy': scipy.__version__, 'scikit-learn': sklearn.__version__, 'python': sys.version.split()[0]},
        },
        'limitations': ['Research model without clinical validation', 'Trained on hospital pulse-oximeter PPG, not phone-camera PPG', 'Single ECG lead estimated in relative units; electrical activity is not measured', 'No interval measurements or diagnoses', 'Subject-disjoint evaluation is not an external clinical study'],
        'parity': {'record': parity_record[0], 'input': parity_input.tolist(), 'expected': parity_expected.tolist()},
        'filterParity': {'input': parity_record[5][:INPUT].tolist(), 'expected': bessel_filter(parity_record[5][:INPUT]).tolist()},
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(model_json, separators=(',', ':'), ensure_ascii=False) + '\n')
    artifact_hash = hashlib.sha256(args.output.read_bytes()).hexdigest()
    card = {
        'modelId': model_json['modelId'], 'dataset': 'BIDMC 1.0.0 · PhysioNet',
        'subjects': {name: len(values) for name, values in split.items()},
        'records': {name: len(values) for name, values in split_records.items()},
        'test': {'pearson': evaluation['test']['pearson'], 'rmse': evaluation['test']['rmse'], 'baselineRmse': evaluation['test']['zeroBaselineRmse'], 'improvementPercent': evaluation['test']['rmseImprovementPct']},
        'suitability': 'insufficient', 'sampleRate': FS, 'inputLength': INPUT, 'outputLength': OUTPUT,
        'latencyMs': (INPUT - 1 - START) / FS * 1000,
        'sourceUrl': 'https://physionet.org/content/bidmc/1.0.0/', 'artifactSha256': artifact_hash,
        'notes': ['Concordancia insuficiente para interpretar un ECG individual', 'Entrenado con pulsioxímetro hospitalario; sin evaluación pareada cámara/ECG', 'Salida en unidades relativas; no mide actividad eléctrica'],
    }
    args.output.with_name('ppgToEcg.card.json').write_text(json.dumps(card, indent=2, ensure_ascii=False) + '\n')
    report = {'artifactSha256': artifact_hash, 'metrics': evaluation, 'subjectSplits': split, 'recordSplits': split_records, 'selectedCandidate': selected_name, 'candidateComparison': [{key: value for key, value in candidate.items() if key != 'history'} for candidate in comparison], 'selectedEpoch': best_epoch, 'runtimeSeconds': time.monotonic() - start_time}
    (args.cache / 'training-report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2), flush=True)


if __name__ == '__main__':
    main()
