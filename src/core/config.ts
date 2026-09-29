import * as vscode from 'vscode';
import type { ReadPreferenceMode } from 'mongodb';

export interface CompassConfig {
  defaultLimit: number;
  maxTimeMS: number;
  resultView: 'list' | 'table' | 'json';
  schemaSampleSize: number;
  confirmDangerousOperations: boolean;
  queryHistoryLimit: number;
  hideSystemDatabases: boolean;
  showSystemCollections: boolean;
  readPreference: ReadPreferenceMode;
  connectionTimeoutMS: number;
  exportBatchSize: number;
  autoPreviewPipeline: boolean;
}

const SECTION = 'mongoCompass';

export function getConfig(): CompassConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    defaultLimit: cfg.get<number>('defaultLimit', 20),
    maxTimeMS: cfg.get<number>('maxTimeMS', 60000),
    resultView: cfg.get<'list' | 'table' | 'json'>('resultView', 'list'),
    schemaSampleSize: cfg.get<number>('schemaSampleSize', 1000),
    confirmDangerousOperations: cfg.get<boolean>('confirmDangerousOperations', true),
    queryHistoryLimit: cfg.get<number>('queryHistoryLimit', 200),
    hideSystemDatabases: cfg.get<boolean>('hideSystemDatabases', false),
    showSystemCollections: cfg.get<boolean>('showSystemCollections', true),
    readPreference: cfg.get<ReadPreferenceMode>('readPreference', 'primary'),
    connectionTimeoutMS: cfg.get<number>('connectionTimeoutMS', 30000),
    exportBatchSize: cfg.get<number>('exportBatchSize', 1000),
    autoPreviewPipeline: cfg.get<boolean>('autoPreviewPipeline', true)
  };
}

export function onConfigChanged(listener: (config: CompassConfig) => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(SECTION)) {
      listener(getConfig());
    }
  });
}
