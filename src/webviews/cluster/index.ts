import { request, on, getState, setState, el, clear, formatNumber } from '../shared/client';

interface Member {
  id: number;
  host: string;
  state: string;
  health: number;
  self: boolean;
  uptime?: number;
  lagSeconds: number | null;
  pingMs?: number;
  syncSourceHost?: string;
  lastHeartbeatMessage?: string;
  priority: number;
  votes: number;
  hidden: boolean;
  arbiterOnly: boolean;
  secondaryDelaySecs: number;
  tags: Record<string, string>;
}

interface ReplicaSet {
  name: string;
  term?: number;
  configVersion?: number;
  primary?: string;
  members: Member[];
  configsvr: boolean;
  oplog?: { maxSizeMB: number; usedMB: number; windowHours: number | null };
  error?: string;
}

interface Shard {
  id: string;
  host: string;
  hosts: string[];
  draining: boolean;
  zones: string[];
  replicaSet?: ReplicaSet;
}

interface Collection {
  namespace: string;
  key: Record<string, unknown>;
  unique: boolean;
  balancingEnabled: boolean;
  chunksByShard: Record<string, number>;
  totalChunks: number;
  dataByShard?: Array<{ shard: string; documents: number; sizeBytes: number; orphanedDocuments: number }>;
}

interface Overview {
  kind: 'standalone' | 'replicaSet' | 'sharded';
  connectionName: string;
  serverVersion: string;
  featureCompatibilityVersion?: string;
  defaultWriteConcern?: Record<string, unknown>;
  isAtlas: boolean;
  fetchedAt: number;
  host?: string;
  replicaSet?: ReplicaSet;
  sharding?: {
    shards: Shard[];
    routers: Array<{ host: string; ping?: string; upSeconds?: number; version?: string; stale: boolean }>;
    configServers?: ReplicaSet & { hosts: string[] };
    balancer: { mode: string; running: boolean; inBalancerRound: boolean; numBalancerRounds?: number; window?: { start: string; stop: string }; error?: string };
    databases: Array<{ name: string; primary: string }>;
    collections: Collection[];
    zones: Array<{ namespace: string; zone: string; min: unknown; max: unknown }>;
  };
  warnings: string[];
}

interface User {
  user: string;
  db: string;
  roles: Array<{ role: string; db: string }>;
  mechanisms?: string[];
}

type Tab = 'overview' | 'members' | 'sharding' | 'users';

interface UiState {
  tab: Tab;
  auto: boolean;
}

const ui: UiState = getState<UiState>({ tab: 'overview', auto: false });
let data: Overview | null = null;
let error: string | null = null;
let users: User[] | null = null;
let usersError: string | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let busy = false;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const content = $('content');
const tabsEl = $('tabs');
const modalRoot = $('modal-root');
const autoBox = $<HTMLInputElement>('auto');
const SHARD_COLORS = ['--vscode-charts-blue', '--vscode-charts-green', '--vscode-charts-orange', '--vscode-charts-purple', '--vscode-charts-red', '--vscode-charts-yellow'];

// ───────────────────────────── plumbing ─────────────────────────────

function persist(): void {
  setState(ui);
}

function setAuto(enabled: boolean): void {
  ui.auto = enabled;
  autoBox.checked = enabled;
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
  if (enabled) {
    timer = setInterval(() => void refresh(true), 10_000);
  }
  persist();
}

async function refresh(quiet = false): Promise<void> {
  if (busy) {
    return;
  }
  busy = true;
  if (!quiet) {
    $('updated').textContent = 'refreshing…';
  }
  try {
    const result = await request<{ data: Overview }>('refresh');
    data = result.data;
    error = null;
  } catch (err) {
    error = (err as Error).message;
  } finally {
    busy = false;
    render();
  }
}

/** Run a VS Code command for this cluster, then reload. */
async function action(command: string, target: Record<string, unknown> = {}): Promise<void> {
  try {
    await request('action', { command: `mongoCompass.cluster.${command}`, target });
  } catch (err) {
    toast((err as Error).message, true);
  }
  await refresh();
}

function toast(message: string, isError = false): void {
  $('updated').textContent = message;
  $('updated').style.color = isError ? 'var(--vscode-errorForeground)' : '';
}

function button(label: string, title: string, handler: () => void, kind = ''): HTMLButtonElement {
  const b = el('button', { className: `mc-btn ${kind}`.trim(), text: label, title });
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    handler();
  });
  return b;
}

function closeModal(): void {
  clear(modalRoot);
}

function openModal(title: string, body: HTMLElement, actions: HTMLElement[]): void {
  closeModal();
  const backdrop = el('div', { className: 'mc-modal-backdrop' });
  const modal = el('div', { className: 'mc-modal' }, el('h3', { text: title }), body);
  const row = el('div', { className: 'mc-modal-actions' }, button('Cancel', 'Close', closeModal), ...actions);
  modal.append(row);
  backdrop.append(modal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      closeModal();
    }
  });
  modalRoot.append(backdrop);
}

function input(placeholder: string, value = '', type = 'text'): HTMLInputElement {
  return el('input', { className: 'mc-input', placeholder, value, type });
}

function field(label: string, control: HTMLElement): HTMLLabelElement {
  return el('label', {}, el('span', { text: label }), control);
}

function formatBytes(bytes: number): string {
  if (!bytes) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function shardColor(shards: string[], shard: string): string {
  return `var(${SHARD_COLORS[Math.max(0, shards.indexOf(shard)) % SHARD_COLORS.length]})`;
}

// ───────────────────────────── render ─────────────────────────────

function renderTabs(): void {
  clear(tabsEl);
  const tabs: Array<[Tab, string]> = [['overview', 'Overview'], ['members', 'Replica sets']];
  if (data?.kind === 'sharded') {
    tabs.push(['sharding', 'Sharding']);
  }
  tabs.push(['users', 'Users & roles']);
  if (!tabs.some(([t]) => t === ui.tab)) {
    ui.tab = 'overview';
  }
  for (const [tab, label] of tabs) {
    const t = el('div', { className: `mc-tab${ui.tab === tab ? ' active' : ''}`, text: label });
    t.addEventListener('click', () => {
      ui.tab = tab;
      persist();
      render();
      if (tab === 'users' && !users) {
        void loadUsers();
      }
    });
    tabsEl.append(t);
  }
}

function render(): void {
  renderTabs();
  clear(content);
  if (data) {
    $('title').textContent = `${data.connectionName} — ${data.kind}`;
    $('updated').textContent = `updated ${new Date(data.fetchedAt).toLocaleTimeString()}`;
    $('updated').style.color = '';
  }
  if (error) {
    content.append(el('div', { className: 'mc-empty' }, el('span', { className: 'mc-error-text', text: error })));
    return;
  }
  if (!data) {
    content.append(el('div', { className: 'mc-empty' }, el('span', { className: 'mc-spinner' }), 'Loading…'));
    return;
  }
  switch (ui.tab) {
    case 'overview':
      renderOverview(data);
      break;
    case 'members':
      renderReplicaSets(data);
      break;
    case 'sharding':
      renderSharding(data);
      break;
    case 'users':
      renderUsers();
      break;
  }
}

function card(key: string, value: string, sub = ''): HTMLElement {
  return el('div', { className: 'cl-card' }, el('div', { className: 'k', text: key }), el('div', { className: 'v', text: value }), el('div', { className: 's', text: sub }));
}

function allSets(d: Overview): Array<{ label: string; rs: ReplicaSet; shard?: string }> {
  if (d.replicaSet) {
    return [{ label: d.replicaSet.name, rs: d.replicaSet }];
  }
  const sets: Array<{ label: string; rs: ReplicaSet; shard?: string }> = [];
  if (d.sharding?.configServers) {
    sets.push({ label: `Config servers (${d.sharding.configServers.name})`, rs: d.sharding.configServers });
  }
  for (const shard of d.sharding?.shards ?? []) {
    if (shard.replicaSet) {
      sets.push({ label: `Shard ${shard.id}`, rs: shard.replicaSet, shard: shard.id });
    }
  }
  return sets;
}

function renderOverview(d: Overview): void {
  const sets = allSets(d);
  const members = sets.flatMap((s) => s.rs.members);
  const healthy = members.filter((m) => m.health === 1).length;
  const cards = el('div', { className: 'cl-cards' });
  cards.append(
    card('Topology', d.kind === 'replicaSet' ? 'Replica set' : d.kind === 'sharded' ? 'Sharded cluster' : 'Standalone', d.isAtlas ? 'MongoDB Atlas' : 'self-managed'),
    card('Version', d.serverVersion, d.featureCompatibilityVersion ? `FCV ${d.featureCompatibilityVersion}` : '')
  );
  if (members.length) {
    cards.append(card('Members', `${healthy}/${members.length}`, `${sets.length} replica set(s)`));
  }
  if (d.sharding) {
    cards.append(
      card('Shards', String(d.sharding.shards.length), `${d.sharding.routers.length} router(s)`),
      card('Balancer', d.sharding.balancer.running ? 'running' : 'stopped', d.sharding.balancer.window ? `window ${d.sharding.balancer.window.start}–${d.sharding.balancer.window.stop}` : d.sharding.balancer.inBalancerRound ? 'balancing now' : ''),
      card('Sharded collections', String(d.sharding.collections.length), `${d.sharding.databases.length} database(s)`)
    );
  }
  const oplog = d.replicaSet?.oplog;
  if (oplog) {
    cards.append(card('Oplog window', oplog.windowHours === null ? '—' : `${oplog.windowHours} h`, `${oplog.usedMB} / ${oplog.maxSizeMB} MB`));
  }
  if (d.defaultWriteConcern) {
    cards.append(card('Default write concern', JSON.stringify(d.defaultWriteConcern)));
  }
  content.append(cards);

  if (d.warnings.length) {
    const list = el('ul', { style: 'margin: 0; padding-left: 18px;' } as never);
    for (const warning of d.warnings) {
      list.append(el('li', { text: warning }));
    }
    content.append(el('div', { className: 'cl-warnings' }, el('strong', { text: 'Attention' }), list));
  }

  const section = el('div', { className: 'cl-section' }, el('span', { text: 'Topology' }), el('span', { className: 'spacer' }));
  if (d.kind !== 'standalone') {
    section.append(
      button('Set FCV…', 'setFeatureCompatibilityVersion', () => void action('setFcv')),
      button('Default write concern…', 'setDefaultRWConcern', () => void action('setDefaultWriteConcern'))
    );
  }
  if (d.kind === 'replicaSet') {
    section.append(button('Oplog', 'Browse local.oplog.rs, newest first', () => void action('openOplog')));
  }
  content.append(section);
  content.append(renderDiagram(d));
}

function renderDiagram(d: Overview): HTMLElement {
  const diagram = el('div', { className: 'cl-diagram' });
  if (d.kind === 'standalone') {
    diagram.append(el('div', { className: 'cl-router', text: `${d.host ?? 'server'} — standalone (no replication, no failover)` }));
    return diagram;
  }
  if (d.kind === 'replicaSet' && d.replicaSet) {
    diagram.append(renderReplicaSet(d.replicaSet.name, d.replicaSet, true));
    return diagram;
  }
  const sharding = d.sharding;
  if (!sharding) {
    return diagram;
  }
  diagram.append(el('div', { className: 'cl-tier-label', text: 'Application → routers (mongos)' }));
  const routers = el('div', { className: 'cl-tier' });
  for (const r of sharding.routers) {
    routers.append(el('div', { className: `cl-router${r.stale ? ' stale' : ''}`, text: `${r.host}${r.version ? ` · v${r.version}` : ''}${r.stale ? ' · stale' : ''}`, title: `last ping ${r.ping ?? 'never'}` }));
  }
  if (!sharding.routers.length) {
    routers.append(el('div', { className: 'cl-empty', text: 'No routers registered in config.mongos' }));
  }
  diagram.append(routers, el('div', { className: 'cl-arrow', text: '▼' }));
  if (sharding.configServers) {
    diagram.append(renderReplicaSet(`Config servers · ${sharding.configServers.name}`, sharding.configServers, true));
  }
  diagram.append(el('div', { className: 'cl-arrow', text: '▼' }));
  const shardIds = sharding.shards.map((s) => s.id);
  for (const shard of sharding.shards) {
    const rs = shard.replicaSet ?? { name: shard.id, members: [], configsvr: false, error: 'not loaded' };
    const box = renderReplicaSet(`Shard ${shard.id}${shard.draining ? ' · DRAINING' : ''}${shard.zones.length ? ` · zones: ${shard.zones.join(', ')}` : ''}`, rs, true, shard.id);
    box.style.borderColor = shardColor(shardIds, shard.id);
    diagram.append(box);
  }
  return diagram;
}

function lagBar(member: Member): HTMLElement | null {
  if (member.lagSeconds === null || member.state === 'PRIMARY' || member.arbiterOnly) {
    return null;
  }
  const lag = member.lagSeconds;
  const bar = el('div', { className: `cl-lag-bar${lag > 60 ? ' bad' : lag > 10 ? ' warn' : ''}`, title: `${lag}s behind the primary` });
  bar.append(el('div', { style: `width: ${Math.max(4, 100 - Math.min(100, lag))}%` } as never));
  return bar;
}

function renderMember(rs: ReplicaSet, m: Member, withActions: boolean): HTMLElement {
  const kind = m.health !== 1 ? 'down' : ['PRIMARY', 'SECONDARY', 'ARBITER'].includes(m.state) ? m.state : 'other';
  const box = el('div', { className: `cl-member ${kind}` });
  box.append(el('div', { className: 'host', text: m.host }));
  const state = m.health === 1 ? m.state : `DOWN${m.lastHeartbeatMessage ? ` — ${m.lastHeartbeatMessage}` : ''}`;
  box.append(el('div', {}, el('span', { className: 'state', text: state }), el('span', { text: m.lagSeconds !== null && m.state !== 'PRIMARY' ? ` · ${m.lagSeconds}s lag` : '' })));
  const bar = lagBar(m);
  if (bar) {
    box.append(bar);
  }
  const flags = el('div', { className: 'flags' });
  const flag = (text: string): void => {
    flags.append(el('span', { className: 'mc-badge', text }));
  };
  flag(`p ${m.priority}`);
  flag(`votes ${m.votes}`);
  if (m.hidden) {
    flag('hidden');
  }
  if (m.secondaryDelaySecs) {
    flag(`delay ${m.secondaryDelaySecs}s`);
  }
  for (const [k, v] of Object.entries(m.tags ?? {})) {
    flag(`${k}=${v}`);
  }
  if (m.syncSourceHost) {
    flags.append(el('span', { className: 'mc-muted', text: `← ${m.syncSourceHost}`, style: 'font-size: 11px' } as never));
  }
  box.append(flags);
  if (withActions) {
    const target = { host: m.host, replicaSet: rs.name, state: m.state };
    const actions = el('div', { className: 'actions' });
    if (m.state === 'PRIMARY') {
      actions.append(button('Step down', 'replSetStepDown', () => void action('stepDown', target)));
    }
    if (m.state === 'SECONDARY' && !m.hidden && m.priority > 0 && !m.secondaryDelaySecs) {
      actions.append(button('Make primary', 'Elect this member', () => void action('makePrimary', target), 'primary'));
    }
    if (m.state === 'SECONDARY') {
      actions.append(button('Freeze', 'replSetFreeze', () => void action('freeze', target)));
      actions.append(button('Sync from…', 'replSetSyncFrom', () => void action('syncFrom', target)));
    }
    if (m.state === 'SECONDARY' || m.state === 'RECOVERING') {
      actions.append(button('Maintenance', 'Toggle replSetMaintenance', () => void action('maintenance', target)));
    }
    if (!m.arbiterOnly) {
      actions.append(button('Settings…', 'Priority, votes, hidden, delay, tags', () => void action('memberSettings', target)));
    }
    if (m.health === 1) {
      actions.append(button('Status', 'serverStatus of this member', () => void action('nodeStatus', target)));
      actions.append(button('Log', 'Recent log lines (getLog)', () => void action('nodeLog', target)));
    }
    actions.append(button('Remove', 'Remove from the replica set', () => void action('removeMember', target), 'danger'));
    box.append(actions);
  }
  return box;
}

function renderReplicaSet(label: string, rs: ReplicaSet, withActions: boolean, shard?: string): HTMLElement {
  const box = el('div', { className: 'cl-rs' });
  const head = el('div', { className: 'cl-rs-head' }, el('span', { className: 'name', text: label }));
  if (rs.error) {
    head.append(el('span', { className: 'meta', text: `not reachable directly: ${rs.error}` }));
    box.append(head);
    if (shard) {
      box.append(el('div', { className: 'actions' }, button('Remove shard…', 'Drain and remove', () => void action('removeShard', { shard }), 'danger')));
    }
    return box;
  }
  const meta = [`${rs.members.filter((m) => m.health === 1).length}/${rs.members.length} healthy`, rs.term !== undefined ? `term ${rs.term}` : '', rs.configVersion !== undefined ? `config v${rs.configVersion}` : '', rs.oplog?.windowHours !== null && rs.oplog?.windowHours !== undefined ? `oplog ${rs.oplog.windowHours}h` : '']
    .filter(Boolean)
    .join(' · ');
  head.append(el('span', { className: 'meta', text: meta }), el('span', { className: 'spacer' }));
  if (withActions) {
    const host = rs.primary ?? rs.members[0]?.host;
    head.append(
      button('＋ Member…', 'Add a member (replSetReconfig)', () => void action('addMember', { replicaSet: rs.name, host })),
      button('Edit config…', 'Edit the replica set config with safety checks', () => void editConfig(host))
    );
    if (shard) {
      head.append(button('Remove shard…', 'Drain and remove', () => void action('removeShard', { shard }), 'danger'));
    }
  }
  box.append(head);
  const grid = el('div', { className: 'cl-members' });
  for (const m of rs.members) {
    grid.append(renderMember(rs, m, withActions));
  }
  box.append(grid);
  return box;
}

function renderReplicaSets(d: Overview): void {
  const sets = allSets(d);
  if (!sets.length) {
    content.append(el('div', { className: 'cl-empty', text: 'This server is not part of a replica set.' }));
    return;
  }
  for (const { label, rs, shard } of sets) {
    content.append(renderReplicaSet(label, rs, true, shard));
    content.append(renderMemberTable(rs));
  }
}

function renderMemberTable(rs: ReplicaSet): HTMLElement {
  const table = el('table', { className: 'cl-table' });
  const head = el('tr');
  for (const h of ['_id', 'host', 'state', 'health', 'lag', 'ping', 'uptime', 'priority', 'votes', 'sync source']) {
    head.append(el('th', { text: h }));
  }
  table.append(el('thead', {}, head));
  const body = el('tbody');
  for (const m of rs.members) {
    const row = el('tr');
    for (const value of [String(m.id), m.host, m.state, m.health === 1 ? 'up' : 'down', m.lagSeconds === null ? '—' : `${m.lagSeconds}s`, m.pingMs === undefined ? '—' : `${m.pingMs} ms`, m.uptime === undefined ? '—' : `${Math.round(m.uptime / 60)} min`, String(m.priority), String(m.votes), m.syncSourceHost ?? '—']) {
      row.append(el('td', { className: 'mono', text: value }));
    }
    body.append(row);
  }
  table.append(body);
  return el('div', { style: 'margin-bottom: 16px; overflow-x: auto;' } as never, table);
}

function renderSharding(d: Overview): void {
  const s = d.sharding;
  if (!s) {
    return;
  }
  const shardIds = s.shards.map((x) => x.id);

  // Balancer
  const b = s.balancer;
  const balancer = el('div', { className: 'cl-section' }, el('span', { text: 'Balancer' }), el('span', { className: `cl-pill ${b.running ? 'on' : 'off'}`, text: b.running ? 'running' : 'stopped' }));
  if (b.inBalancerRound) {
    balancer.append(el('span', { className: 'mc-badge', text: 'balancing now' }));
  }
  if (b.window) {
    balancer.append(el('span', { className: 'mc-badge', text: `window ${b.window.start}–${b.window.stop}` }));
  }
  balancer.append(
    el('span', { className: 'spacer' }),
    b.running ? button('Stop', 'balancerStop', () => void action('stopBalancer')) : button('Start', 'balancerStart', () => void action('startBalancer'), 'primary'),
    button('Window…', 'Set or clear the active window', () => void action('balancerWindow'))
  );
  content.append(balancer);

  // Shards
  const shardsHead = el('div', { className: 'cl-section' }, el('span', { text: `Shards (${s.shards.length})` }), el('span', { className: 'spacer' }), button('＋ Add shard…', 'addShard', () => void action('addShard'), 'primary'));
  content.append(shardsHead);
  const shardTable = el('table', { className: 'cl-table' });
  shardTable.append(el('thead', {}, el('tr', {}, ...['shard', 'replica set hosts', 'state', 'zones', ''].map((h) => el('th', { text: h })))));
  const shardBody = el('tbody');
  for (const shard of s.shards) {
    const actions = el('td', {}, button('Zone…', 'Add to a zone', () => void action('addShardToZone', { shard: shard.id })));
    for (const zone of shard.zones) {
      actions.append(button(`− ${zone}`, `Remove from zone ${zone}`, () => void action('removeShardFromZone', { shard: shard.id, zone })));
    }
    actions.append(button('Remove…', 'Drain and remove', () => void action('removeShard', { shard: shard.id }), 'danger'));
    const name = el('td', { className: 'mono' }, el('span', { text: '■ ', style: `color: ${shardColor(shardIds, shard.id)}` } as never), shard.id);
    shardBody.append(el('tr', {}, name, el('td', { className: 'mono', text: shard.host }), el('td', { text: shard.draining ? 'draining' : 'active' }), el('td', { text: shard.zones.join(', ') || '—' }), actions));
  }
  shardTable.append(shardBody);
  content.append(shardTable);

  // Sharded collections
  const colHead = el('div', { className: 'cl-section' }, el('span', { text: `Sharded collections (${s.collections.length})` }), el('span', { className: 'spacer' }), button('＋ Shard a collection…', 'shardCollection', () => void action('shardCollection'), 'primary'));
  content.append(colHead);
  const legend = el('div', { className: 'cl-legend' });
  for (const id of shardIds) {
    legend.append(el('span', { text: id, style: `--c: ${shardColor(shardIds, id)}` } as never));
  }
  content.append(legend);
  if (!s.collections.length) {
    content.append(el('div', { className: 'cl-empty', text: 'No sharded collections yet.' }));
  } else {
    const table = el('table', { className: 'cl-table' });
    table.append(el('thead', {}, el('tr', {}, ...['namespace', 'shard key', 'chunks', 'data by shard', 'balancing', ''].map((h) => el('th', { text: h })))));
    const body = el('tbody');
    for (const c of s.collections) {
      const dist = el('div', { className: 'cl-dist', title: Object.entries(c.chunksByShard).map(([k, v]) => `${k}: ${v} chunks`).join('\n') });
      for (const [shard, n] of Object.entries(c.chunksByShard)) {
        dist.append(el('div', { style: `width: ${(n / Math.max(1, c.totalChunks)) * 100}%; background: ${shardColor(shardIds, shard)}` } as never));
      }
      const dataCell = el('td', { className: 'mono' });
      if (c.dataByShard?.length) {
        const total = c.dataByShard.reduce((sum, x) => sum + x.sizeBytes, 0);
        const bar = el('div', { className: 'cl-dist' });
        for (const x of c.dataByShard) {
          bar.append(el('div', { style: `width: ${total ? (x.sizeBytes / total) * 100 : 0}%; background: ${shardColor(shardIds, x.shard)}`, title: `${x.shard}: ${formatNumber(x.documents)} docs, ${formatBytes(x.sizeBytes)}${x.orphanedDocuments ? `, ${x.orphanedDocuments} orphans` : ''}` } as never));
        }
        dataCell.append(bar, el('div', { text: c.dataByShard.map((x) => `${x.shard}: ${formatNumber(x.documents)} / ${formatBytes(x.sizeBytes)}`).join(' · '), style: 'font-size: 11px; opacity: .8; margin-top: 3px' } as never));
      } else {
        dataCell.textContent = '—';
      }
      const target = { namespace: c.namespace, database: c.namespace.split('.')[0] };
      const actions = el('td');
      actions.append(
        button(c.balancingEnabled ? 'Disable balancing' : 'Enable balancing', 'Per-collection balancing', () => void action('toggleCollectionBalancing', target)),
        button('Reshard…', 'reshardCollection', () => void action('reshardCollection', target)),
        button('Refine key…', 'refineCollectionShardKey', () => void action('refineShardKey', target)),
        button('Analyze key…', 'analyzeShardKey (7.0+)', () => void action('analyzeShardKey', target)),
        button('Zone range…', 'updateZoneKeyRange', () => zoneRangeForm(c.namespace)),
        button('Move range…', 'moveRange', () => moveRangeForm(c.namespace, shardIds)),
        button('Split…', 'split at a key', () => splitForm(c.namespace)),
        button('Unshard…', 'unshardCollection (8.0+)', () => void action('unshardCollection', target), 'danger')
      );
      body.append(
        el(
          'tr',
          {},
          el('td', { className: 'mono', text: c.namespace }),
          el('td', { className: 'mono', text: `${JSON.stringify(c.key)}${c.unique ? ' unique' : ''}` }),
          el('td', {}, el('div', { text: String(c.totalChunks) }), dist),
          dataCell,
          el('td', {}, el('span', { className: `cl-pill ${c.balancingEnabled ? 'on' : 'off'}`, text: c.balancingEnabled ? 'on' : 'off' })),
          actions
        )
      );
    }
    table.append(body);
    content.append(el('div', { style: 'overflow-x: auto' } as never, table));
  }

  // Zones
  content.append(el('div', { className: 'cl-section' }, el('span', { text: `Zone ranges (${s.zones.length})` })));
  if (s.zones.length) {
    const table = el('table', { className: 'cl-table' });
    table.append(el('thead', {}, el('tr', {}, ...['namespace', 'zone', 'min', 'max', ''].map((h) => el('th', { text: h })))));
    const body = el('tbody');
    for (const z of s.zones) {
      const remove = button('Remove', 'Remove this range', () => {
        void request('zoneRange', { namespace: z.namespace, min: JSON.stringify(z.min), max: JSON.stringify(z.max), zone: null })
          .then(() => refresh())
          .catch((err: Error) => toast(err.message, true));
      }, 'danger');
      body.append(el('tr', {}, el('td', { className: 'mono', text: z.namespace }), el('td', { text: z.zone }), el('td', { className: 'mono', text: JSON.stringify(z.min) }), el('td', { className: 'mono', text: JSON.stringify(z.max) }), el('td', {}, remove)));
    }
    table.append(body);
    content.append(table);
  } else {
    content.append(el('div', { className: 'cl-empty', text: 'No zone ranges. Add shards to zones above, then assign key ranges per collection.' }));
  }

  // Databases
  content.append(el('div', { className: 'cl-section' }, el('span', { text: 'Database primary shards' })));
  const dbTable = el('table', { className: 'cl-table' });
  dbTable.append(el('thead', {}, el('tr', {}, ...['database', 'primary shard', ''].map((h) => el('th', { text: h })))));
  const dbBody = el('tbody');
  for (const db of s.databases) {
    dbBody.append(el('tr', {}, el('td', { className: 'mono', text: db.name }), el('td', { className: 'mono', text: db.primary }), el('td', {}, button('Move primary…', 'movePrimary', () => void action('movePrimary', { database: db.name })))));
  }
  dbTable.append(dbBody);
  content.append(dbTable);
}

// ───────────────────────────── forms ─────────────────────────────

function report(target: HTMLElement, result: { errors: string[]; warnings: string[] }): void {
  clear(target);
  if (!result.errors.length && !result.warnings.length) {
    target.append(el('div', { className: 'ok', text: '✔ All safety checks passed.' }));
  }
  for (const e of result.errors) {
    target.append(el('div', { className: 'err', text: `✖ ${e}` }));
  }
  for (const w of result.warnings) {
    target.append(el('div', { className: 'warn', text: `⚠ ${w}` }));
  }
}

async function editConfig(host?: string): Promise<void> {
  let text: string;
  try {
    text = (await request<{ text: string }>('getConfig', { host })).text;
  } catch (err) {
    toast((err as Error).message, true);
    return;
  }
  const area = el('textarea', { className: 'mc-textarea cl-config', value: text, spellcheck: false });
  const result = el('div', { className: 'cl-report' });
  const force = el('input', { type: 'checkbox' });
  const body = el(
    'div',
    { className: 'cl-form' },
    el('div', { className: 'mc-muted', text: 'The version is raised automatically. Safe reconfig allows changing one voting member at a time.', style: 'font-size: 12px' } as never),
    area,
    result,
    el('label', { style: 'display: flex; gap: 6px; align-items: center' } as never, force, el('span', { text: 'force: true (only to recover a replica set that lost its majority — may roll back writes)' }))
  );
  const preview = button('Check', 'Validate without applying', () => {
    void request<{ report: { errors: string[]; warnings: string[] } }>('previewConfig', { host, text: area.value })
      .then((r) => report(result, r.report))
      .catch((err: Error) => report(result, { errors: [err.message], warnings: [] }));
  });
  const apply = button('Apply', 'replSetReconfig', () => {
    void request<{ ok?: boolean; cancelled?: boolean }>('applyConfig', { host, text: area.value, force: force.checked })
      .then((r) => {
        if (r.ok) {
          closeModal();
          toast('Replica set config applied.');
          void refresh();
        }
      })
      .catch((err: Error) => report(result, { errors: [err.message], warnings: [] }));
  }, 'primary');
  openModal('Replica set config', body, [preview, apply]);
}

function zoneRangeForm(namespace: string): void {
  const zone = input('zone name');
  const min = input('{ field: MinKey() }', '{  }');
  const max = input('{ field: MaxKey() }', '{  }');
  const status = el('div', { className: 'cl-report' });
  openModal(`Zone range — ${namespace}`, el('div', { className: 'cl-form' }, field('Zone', zone), el('div', { className: 'row' }, field('Min (inclusive)', min), field('Max (exclusive)', max)), status), [
    button('Assign', 'updateZoneKeyRange', () => {
      void request('zoneRange', { namespace, min: min.value, max: max.value, zone: zone.value.trim() || null })
        .then(() => {
          closeModal();
          void refresh();
        })
        .catch((err: Error) => report(status, { errors: [err.message], warnings: [] }));
    }, 'primary')
  ]);
}

function moveRangeForm(namespace: string, shards: string[]): void {
  const min = input('{ shardKeyField: value }', '{  }');
  const select = el('select', { className: 'mc-select' });
  for (const shard of shards) {
    select.append(el('option', { value: shard, text: shard }));
  }
  const status = el('div', { className: 'cl-report' });
  openModal(`Move range — ${namespace}`, el('div', { className: 'cl-form' }, field('Lower bound of the range (min)', min), field('To shard', select), status), [
    button('Move', 'moveRange', () => {
      status.textContent = 'Moving…';
      void request('moveRange', { namespace, min: min.value, toShard: select.value })
        .then(() => {
          closeModal();
          void refresh();
        })
        .catch((err: Error) => report(status, { errors: [err.message], warnings: [] }));
    }, 'primary')
  ]);
}

function splitForm(namespace: string): void {
  const middle = input('{ shardKeyField: value }', '{  }');
  const status = el('div', { className: 'cl-report' });
  openModal(`Split chunk — ${namespace}`, el('div', { className: 'cl-form' }, field('Split point (exact shard key value)', middle), status), [
    button('Split', 'split', () => {
      void request('split', { namespace, middle: middle.value })
        .then(() => {
          closeModal();
          void refresh();
        })
        .catch((err: Error) => report(status, { errors: [err.message], warnings: [] }));
    }, 'primary')
  ]);
}

// ───────────────────────────── users ─────────────────────────────

async function loadUsers(): Promise<void> {
  try {
    users = (await request<{ users: User[] }>('listUsers')).users;
    usersError = null;
  } catch (err) {
    usersError = (err as Error).message;
  }
  if (ui.tab === 'users') {
    render();
  }
}

function parseRoles(text: string, defaultDb: string): Array<{ role: string; db: string }> {
  return text
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [role, db] = r.split('@');
      return { role, db: db || defaultDb };
    });
}

function renderUsers(): void {
  const head = el('div', { className: 'cl-section' }, el('span', { text: 'Users' }), el('span', { className: 'spacer' }), button('⟳', 'Reload users', () => void loadUsers()), button('＋ Create user…', 'createUser', () => createUserForm(), 'primary'));
  content.append(head);
  if (usersError) {
    content.append(el('div', { className: 'mc-error-text', text: usersError }));
    return;
  }
  if (!users) {
    content.append(el('div', { className: 'cl-empty', text: 'Loading users…' }));
    void loadUsers();
    return;
  }
  const table = el('table', { className: 'cl-table' });
  table.append(el('thead', {}, el('tr', {}, ...['user', 'database', 'roles', 'mechanisms', ''].map((h) => el('th', { text: h })))));
  const body = el('tbody');
  for (const u of users) {
    const run = (type: string, payload: Record<string, unknown>): void => {
      void request<{ ok?: boolean }>(type, { db: u.db, user: u.user, ...payload })
        .then(() => loadUsers())
        .catch((err: Error) => toast(err.message, true));
    };
    const roles = el('td', { className: 'mono' });
    for (const r of u.roles) {
      const pill = el('span', { className: 'mc-badge', text: `${r.role}@${r.db} ✕`, title: 'Revoke', style: 'cursor: pointer; margin: 0 4px 4px 0; display: inline-block' } as never);
      pill.addEventListener('click', () => run('grantRoles', { roles: [r], revoke: true }));
      roles.append(pill);
    }
    const grant = input('role@db, …');
    grant.style.width = '160px';
    const actions = el(
      'td',
      {},
      grant,
      button('Grant', 'grantRolesToUser', () => run('grantRoles', { roles: parseRoles(grant.value, u.db) })),
      button('Password…', 'Change password', () => run('changePassword', {})),
      button('Drop', 'dropUser', () => run('dropUser', {}), 'danger')
    );
    body.append(el('tr', {}, el('td', { className: 'mono', text: u.user }), el('td', { className: 'mono', text: u.db }), roles, el('td', { text: (u.mechanisms ?? []).join(', ') }), actions));
  }
  table.append(body);
  content.append(table);
  if (!users.length) {
    content.append(el('div', { className: 'cl-empty', text: 'No users. Authentication may be disabled on this deployment.' }));
  }
}

function createUserForm(): void {
  const db = input('admin', 'admin');
  const user = input('user name');
  const password = input('password', '', 'password');
  const roles = input('readWrite@app, clusterMonitor@admin', 'readWrite');
  const list = el('datalist', { id: 'role-list' });
  roles.setAttribute('list', 'role-list');
  void request<{ roles: string[] }>('listRoles', { db: 'admin' }).then((r) => {
    for (const role of r.roles) {
      list.append(el('option', { value: role }));
    }
  }).catch(() => undefined);
  const status = el('div', { className: 'cl-report' });
  openModal(
    'Create user',
    el('div', { className: 'cl-form' }, el('div', { className: 'row' }, field('Authentication database', db), field('User', user)), field('Password', password), field('Roles (role@db, comma separated; db defaults to the authentication database)', roles), list, status),
    [
      button('Create', 'createUser', () => {
        void request('createUser', { db: db.value.trim() || 'admin', user: user.value.trim(), password: password.value, roles: parseRoles(roles.value, db.value.trim() || 'admin') })
          .then(() => {
            closeModal();
            void loadUsers();
          })
          .catch((err: Error) => report(status, { errors: [err.message], warnings: [] }));
      }, 'primary')
    ]
  );
}

// ───────────────────────────── boot ─────────────────────────────

$('btn-refresh').addEventListener('click', () => {
  users = null;
  void refresh();
});
autoBox.addEventListener('change', () => setAuto(autoBox.checked));
on('select', (payload) => {
  const tab = (payload as { tab?: Tab }).tab;
  if (tab) {
    ui.tab = tab;
    persist();
  }
  void refresh();
});

void request<{ data?: Overview; error?: string; tab?: Tab }>('ready').then((r) => {
  data = r.data ?? null;
  error = r.error ?? null;
  if (r.tab) {
    ui.tab = r.tab;
  }
  setAuto(ui.auto);
  render();
});
