import * as vscode from 'vscode';

interface ToolItem {
  label: string;
  description: string;
  icon: string;
  command: string;
}

const TOOLS: ToolItem[] = [
  {
    label: 'Add Connection',
    description: 'Create a new saved connection',
    icon: 'add',
    command: 'mongoCompass.addConnection'
  },
  {
    label: 'Connect with URI',
    description: 'Connect using a connection string',
    icon: 'link',
    command: 'mongoCompass.connectWithUri'
  },
  {
    label: 'Query History',
    description: 'Recently executed queries and pipelines',
    icon: 'history',
    command: 'mongoCompass.showQueryHistory'
  },
  {
    label: 'My Queries',
    description: 'Saved queries and aggregation pipelines',
    icon: 'star',
    command: 'mongoCompass.showSavedQueries'
  },
  {
    label: 'Server Status',
    description: 'Live server metrics (ops, connections, memory)',
    icon: 'dashboard',
    command: 'mongoCompass.showServerStatus'
  },
  {
    label: 'Current Operations',
    description: 'Running operations, with kill support',
    icon: 'pulse',
    command: 'mongoCompass.showCurrentOp'
  },
  {
    label: 'Run Command',
    description: 'Execute a raw database command',
    icon: 'terminal-cmd',
    command: 'mongoCompass.runCommand'
  },
  {
    label: 'Import Data',
    description: 'Import JSON / JSONL / CSV into a collection',
    icon: 'import',
    command: 'mongoCompass.importCollection'
  },
  {
    label: 'Export Collection',
    description: 'Export a collection to JSON / JSONL / CSV',
    icon: 'export',
    command: 'mongoCompass.exportCollection'
  },
  {
    label: 'Output Channel',
    description: 'Show the MongoDB Compass log',
    icon: 'output',
    command: 'mongoCompass.showLogs'
  }
];

class ToolNode extends vscode.TreeItem {
  constructor(tool: ToolItem) {
    super(tool.label, vscode.TreeItemCollapsibleState.None);
    this.description = tool.description;
    this.iconPath = new vscode.ThemeIcon(tool.icon);
    this.command = { command: tool.command, title: tool.label };
    this.contextValue = 'tool';
    this.tooltip = `${tool.label} — ${tool.description}`;
  }
}

/** Static "Tools" tree view — quick access to connection-less features. */
export class MongoToolsProvider implements vscode.TreeDataProvider<ToolNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  getTreeItem(element: ToolNode): vscode.TreeItem {
    return element;
  }

  getChildren(): ToolNode[] {
    return TOOLS.map((tool) => new ToolNode(tool));
  }
}
