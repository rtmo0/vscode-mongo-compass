import * as vscode from 'vscode';
import type { ConnectionOptions } from '../core/types';
import {
  validateConnectionString,
  redactConnectionString
} from '../core/connectionString';

export { validateConnectionString };

/**
 * Connection form — the equivalent of Compass' `@mongodb-js/connection-form`.
 * Implemented with VS Code QuickPick/InputBox flows so it works without a
 * webview, plus an "advanced" editor for full driver options.
 */
export async function promptForConnection(
  existing?: ConnectionOptions
): Promise<ConnectionOptions | undefined> {
  const name = await vscode.window.showInputBox({
    title: 'MongoDB Connection — Name',
    prompt: 'A friendly name for this connection',
    value: existing?.name ?? '',
    placeHolder: 'e.g. Local, Atlas Production',
    validateInput: (value) => (value.trim() ? null : 'Name is required')
  });
  if (name === undefined) {
    return undefined;
  }

  const connectionString = await vscode.window.showInputBox({
    title: 'MongoDB Connection — URI',
    prompt: 'Connection string (credentials are stored securely in the OS keychain)',
    value: existing?.connectionString ?? 'mongodb://localhost:27017',
    placeHolder:
      'mongodb://localhost:27017 or mongodb+srv://user:pass@cluster.mongodb.net',
    password: false,
    validateInput: validateConnectionString
  });
  if (connectionString === undefined) {
    return undefined;
  }

  const advanced = await vscode.window.showQuickPick(
    [
      { label: 'No, save connection', description: 'Use default driver options', value: false },
      { label: 'Yes, edit advanced options', description: 'Read preference, timeout, notes, color', value: true }
    ],
    { title: 'MongoDB Connection — Advanced options', placeHolder: 'Configure advanced options?' }
  );
  if (advanced === undefined) {
    return undefined;
  }

  let readPreference = existing?.readPreference;
  let serverSelectionTimeoutMS = existing?.serverSelectionTimeoutMS;
  let notes = existing?.notes;
  let color = existing?.color;

  if (advanced.value) {
    const pickedReadPreference = await vscode.window.showQuickPick(
      ['primary', 'primaryPreferred', 'secondary', 'secondaryPreferred', 'nearest'].map(
        (value) => ({ label: value })
      ),
      {
        title: 'Read preference',
        placeHolder: 'Select read preference'
      }
    );
    if (pickedReadPreference === undefined) {
      return undefined;
    }
    readPreference = pickedReadPreference.label as ConnectionOptions['readPreference'];

    const timeoutInput = await vscode.window.showInputBox({
      title: 'Server selection timeout (ms)',
      value: String(serverSelectionTimeoutMS ?? 30000),
      validateInput: (value) => (/^\d+$/.test(value.trim()) ? null : 'Enter a number')
    });
    if (timeoutInput === undefined) {
      return undefined;
    }
    serverSelectionTimeoutMS = Number(timeoutInput);

    notes = await vscode.window.showInputBox({
      title: 'Notes (optional)',
      value: notes ?? '',
      placeHolder: 'Any notes about this connection'
    });
    if (notes === undefined) {
      return undefined;
    }

    const pickedColor = await vscode.window.showQuickPick(
      ['(none)', 'green', 'blue', 'red', 'orange', 'purple'].map((value) => ({ label: value })),
      { title: 'Connection color', placeHolder: 'Pick a badge color' }
    );
    if (pickedColor === undefined) {
      return undefined;
    }
    color = pickedColor.label === '(none)' ? undefined : pickedColor.label;
  }

  return {
    id: existing?.id ?? generateId(),
    name: name.trim(),
    connectionString: connectionString.trim(),
    readPreference,
    serverSelectionTimeoutMS,
    notes: notes || undefined,
    color,
    favorite: existing?.favorite,
    lastUsed: existing?.lastUsed
  };
}

/** Quick connect: ask only for a URI and create an ad-hoc connection. */
export async function promptForUri(): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: 'Connect with URI',
    prompt: 'Paste a MongoDB connection string',
    value: 'mongodb://localhost:27017',
    validateInput: validateConnectionString
  });
}

function generateId(): string {
  return `conn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Show a redacted summary of a connection in the status bar. */
export function describeConnection(options: ConnectionOptions): string {
  return `${options.name} (${redactConnectionString(options.connectionString)})`;
}
