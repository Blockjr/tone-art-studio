import { MASTER_TARGETS, analyzeMaster, analyzeTrack, type AiAnalysis, type AiCorrection } from '../audio/mixai';
import { ASSISTANT_NAME, ASSISTANT_ROLE } from '../core/assistant';
import type { Store } from '../core/store';
import { diagnoseProject } from '../help/diagnose';
import { groupTopics, searchTopics, type HelpAction, type HelpTopic } from '../help/topics';
import { el } from './controls';

export interface AssistantOptions {
  onExport?: () => void;
  onOpenRig?: () => void;
  onOpenRemote?: () => void;
  onShowStart?: () => void;
  /** close Sage and reveal the channel that a correction writes to */
  onEditTarget?: (targetId: string) => void;
}

type Tab = 'mix' | 'help';

interface ScanRow {
  trackId: string;
  name: string;
  analysis: AiAnalysis;
  applied: boolean;
}

const MASTER_SCOPE = 'master';

/**
 * The AI Assistant: one panel for measuring and correcting a track or the
 * master bus, plus the in-app help library and session checks.
 *
 * It deliberately shares the AI Mix & Master engine with the insert in the
 * Device Rack, so the numbers and the corrections are the same wherever you
 * start from.
 */
export class AssistantPanel {
  private store: Store;
  private options: AssistantOptions;
  private root: HTMLElement;
  private unsubscribe: (() => void) | null = null;

  private tab: Tab = 'mix';
  private scope = MASTER_SCOPE;
  private target = 0;
  private intensity = 0.8;
  private analysis: AiAnalysis | null = null;
  private applied = new Set<string>();
  /** true while our own store.edit is running, so its emit is not mistaken for an undo */
  private applying = false;
  private status = '';
  private busy = false;
  private token = 0;
  private scan: ScanRow[] | null = null;
  private query = '';
  private openTopics = new Set<string>();

  constructor(store: Store, options: AssistantOptions = {}) {
    this.store = store;
    this.options = options;
    this.root = el('aside', 'agent');
    this.root.id = 'ai-assistant';
    this.root.setAttribute('aria-label', `${ASSISTANT_NAME} AI Assistant`);
    // Top-bar opens on the whole-mix scope; the rack still asks for a track.
    this.scope = MASTER_SCOPE;
  }

  mount(): void {
    document.body.appendChild(this.root);
    this.render();
    this.unsubscribe = this.store.subscribe((reason) => {
      if (reason !== 'structure') return;
      if (!this.applying) {
        // Somebody else changed the project: an undo, a device removal, a
        // rename. The applied marks no longer describe what is in the session.
        this.applied.clear();
        if (this.scan) this.scan = this.scan.map((row) => ({ ...row, applied: false }));
      }
      this.render();
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.root.remove();
  }

  toggle(): void {
    if (this.root.classList.contains('is-open')) this.close();
    else this.open(this.tab);
  }

  /** The top-bar button: always lands on Mix & Master, closes when already there. */
  toggleMix(): void {
    if (this.root.classList.contains('is-open') && this.tab === 'mix') this.close();
    else this.openMixAi();
  }

  open(tab: Tab = this.tab): void {
    this.tab = tab;
    this.root.classList.add('is-open');
    this.render();
  }

  close(): void {
    this.root.classList.remove('is-open');
  }

  /** Opened from the Device Rack or the master strip. */
  openMixAi(scope?: string): void {
    this.tab = 'mix';
    if (scope) {
      this.scope = scope;
      this.analysis = null;
      this.applied.clear();
      this.status = '';
      this.scan = null;
    }
    this.open('mix');
  }

  openHelp(): void {
    this.open('help');
  }

  // ------------------------------------------------------------------ render

  private render(): void {
    this.root.innerHTML = '';

    const head = el('header', 'agent-head');
    const dot = el('span', 'agent-dot');
    const title = el('div', 'agent-title');
    title.append(el('strong', '', ASSISTANT_NAME), el('span', '', ASSISTANT_ROLE));
    const close = el('button', 'tbtn tbtn-sm', '✕');
    close.title = 'Close (Esc)';
    close.addEventListener('click', () => this.close());
    head.append(dot, title, close);

    const tabs = el('div', 'agent-tabs');
    for (const [id, label, hint] of [
      ['mix', 'Mix & Master', 'Shift+M'],
      ['help', 'Help', '?'],
    ] as [Tab, string, string][]) {
      const button = el('button', `agent-tab${this.tab === id ? ' is-on' : ''}`, label);
      button.title = hint;
      button.setAttribute('aria-selected', String(this.tab === id));
      button.addEventListener('click', () => {
        if (this.tab === id) return;
        this.tab = id;
        this.render();
      });
      tabs.appendChild(button);
    }

    const body = el('div', 'agent-body');
    if (this.tab === 'mix') this.renderMix(body);
    else this.renderHelp(body);

    this.root.append(head, tabs, body);
  }

  private renderMix(host: HTMLElement): void {
    const tracks = this.store.project.tracks;
    if (this.scope !== MASTER_SCOPE && !tracks.some((track) => track.id === this.scope)) {
      this.scope = tracks[0]?.id ?? MASTER_SCOPE;
    }

    host.appendChild(
      el(
        'p',
        'agent-intro',
        `${ASSISTANT_NAME} renders the whole mix and every track in it, measures how they fit together, then writes corrections into the channel strips and master chain. Nothing is applied until you say so, and every value stays editable.`,
      ),
    );

    const scopeRow = el('div', 'agent-scope');
    const scopeLabel = el('label', 'agent-label', 'Scope');
    scopeLabel.htmlFor = 'ai-scope';
    const select = el('select', 'agent-select') as HTMLSelectElement;
    select.id = 'ai-scope';
    const masterOption = el('option', '', 'Whole mix (all tracks + master)');
    masterOption.value = MASTER_SCOPE;
    masterOption.selected = this.scope === MASTER_SCOPE;
    select.appendChild(masterOption);
    for (const track of tracks) {
      const option = el('option', '', track.name);
      option.value = track.id;
      option.selected = this.scope === track.id;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      this.scope = select.value;
      this.analysis = null;
      this.applied.clear();
      this.status = '';
      this.scan = null;
      this.render();
    });
    scopeRow.append(scopeLabel, select);
    host.appendChild(scopeRow);

    const isMaster = this.scope === MASTER_SCOPE;

    if (isMaster) {
      const chips = el('div', 'ai-chips');
      MASTER_TARGETS.forEach((entry, index) => {
        const chip = el('button', `ai-chip${index === this.target ? ' is-on' : ''}`, entry.name);
        chip.title = `${entry.lufs} LUFS · ${entry.ceiling} dBTP ceiling`;
        chip.addEventListener('click', () => {
          if (index === this.target) return;
          this.target = index;
          this.analysis = null;
          this.applied.clear();
          this.status = `Aiming for ${entry.lufs} LUFS (${entry.name.toLowerCase()}).`;
          this.render();
        });
        chips.appendChild(chip);
      });
      host.appendChild(chips);
    }

    const intensityRow = el('div', 'ai-row');
    intensityRow.appendChild(el('span', 'ai-label', 'Intensity'));
    const slider = el('input', 'ai-slider') as HTMLInputElement;
    slider.type = 'range';
    slider.min = '20';
    slider.max = '100';
    slider.step = '5';
    slider.value = String(Math.round(this.intensity * 100));
    slider.setAttribute('aria-label', 'Correction intensity');
    const value = el('span', 'ai-value', `${slider.value}%`);
    slider.addEventListener('input', () => {
      value.textContent = `${slider.value}%`;
      this.intensity = Number(slider.value) / 100;
    });
    intensityRow.append(slider, value);
    host.appendChild(intensityRow);

    const actions = el('div', 'agent-actions');
    const run = el('button', 'agent-run', this.busy ? 'Analyzing…' : this.analysis ? 'Analyze again' : isMaster ? 'Analyze whole mix' : 'Analyze track');
    run.disabled = this.busy;
    run.addEventListener('click', () => void this.run());
    actions.appendChild(run);
    host.appendChild(actions);

    if (!isMaster && tracks.length > 1) {
      const scan = el('button', 'agent-link', 'Scan every track');
      scan.title = 'Measure each track in turn and list what stands out';
      scan.disabled = this.busy;
      scan.addEventListener('click', () => void this.scanAll());
      host.appendChild(scan);
    }

    if (this.status) host.appendChild(el('div', 'agent-status', this.status));

    if (this.analysis) this.renderAnalysis(host, this.analysis);
    if (this.scan) this.renderScan(host);
  }

  private renderAnalysis(host: HTMLElement, analysis: AiAnalysis): void {
    const stats = el('div', 'ai-stats');
    const cell = (label: string, text: string, title: string): HTMLElement => {
      const box = el('div', 'ai-stat');
      box.title = title;
      box.append(el('span', 'ai-stat-label', label), el('span', 'ai-stat-value', text));
      return box;
    };
    stats.append(
      cell('LUFS', analysis.stats.lufs.toFixed(1), 'Integrated loudness, BS.1770 gated'),
      cell('TRUE PK', analysis.stats.truePeakDb.toFixed(1), 'Inter-sample peak, 4x oversampled'),
      cell('CREST', `${analysis.stats.crestDb.toFixed(0)} dB`, 'Peak minus RMS'),
      cell('PHASE', analysis.stats.correlation.toFixed(2), 'Left/right correlation'),
    );
    host.appendChild(stats);

    const band = el('div', 'ai-band');
    for (const [name, pct, title] of [
      ['b-low', analysis.stats.bands.low, 'Low (<150 Hz)'],
      ['b-lowmid', analysis.stats.bands.lowMid, 'Low-mid (150–800 Hz)'],
      ['b-mid', analysis.stats.bands.mid, 'Mid (0.8–3 kHz)'],
      ['b-high', analysis.stats.bands.high, 'High (>3 kHz)'],
    ] as [string, number, string][]) {
      const segment = el('span', name);
      segment.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      segment.title = `${title} ${pct.toFixed(0)}%`;
      band.appendChild(segment);
    }
    host.appendChild(band);

    if (analysis.findings?.length) {
      const findings = el('div', 'ai-findings');
      findings.appendChild(el('div', 'section-title', 'Whole-mix notes'));
      for (const finding of analysis.findings) findings.appendChild(el('div', 'ai-finding', finding));
      host.appendChild(findings);
    }

    if (analysis.tracks?.length) {
      const considered = el('div', 'ai-consider');
      considered.appendChild(el('div', 'section-title', `Tracks in context (${analysis.tracks.length})`));
      for (const track of analysis.tracks) {
        const row = el('div', 'ai-consider-row');
        row.append(
          el('span', 'ai-consider-name', track.name),
          el(
            'span',
            'ai-consider-meta',
            track.silent
              ? 'silent / muted'
              : `${track.lufs.toFixed(1)} LUFS · ${track.corrections} fix${track.corrections === 1 ? '' : 'es'}`,
          ),
        );
        considered.appendChild(row);
      }
      host.appendChild(considered);
    }

    if (!analysis.corrections.length) {
      host.appendChild(el('div', 'ai-empty', 'Already balanced for this target — nothing worth changing.'));
      return;
    }

    const pending = analysis.corrections.filter((correction) => !this.applied.has(correction.id));
    const tools = el('div', 'ai-tools');
    const applyAll = el('button', 'ai-apply-all', pending.length ? `Apply all ${pending.length}` : 'All applied ✓');
    applyAll.disabled = pending.length === 0;
    applyAll.addEventListener('click', () => this.apply(pending));
    tools.appendChild(applyAll);
    if (this.applied.size > 0) {
      const undo = el('button', 'ai-undo', 'Undo AI change');
      undo.title = 'One Ctrl+Z step; every applied value is a normal setting you can edit first.';
      undo.addEventListener('click', () => {
        this.store.undo();
        this.applied.clear();
        this.status = 'Last AI change undone — your previous settings are back.';
        this.render();
      });
      tools.appendChild(undo);
    }
    host.appendChild(tools);
    host.appendChild(
      el(
        'p',
        'ai-hint',
        'Every applied value is a normal channel-strip or master control: drag it in the rack or console at any time. Undo AI change (or Ctrl+Z) takes the last pass back.',
      ),
    );

    for (const correction of analysis.corrections) {
      const card = el('div', 'ai-corr');
      const head = el('div', 'ai-corr-head');
      head.appendChild(el('span', `ai-area ${correction.area}`, correction.area.toUpperCase()));
      if (correction.targetName) head.appendChild(el('span', 'ai-target', correction.targetName));
      const actions = el('div', 'ai-corr-actions');
      const done = this.applied.has(correction.id);
      if (
        correction.targetId &&
        correction.targetId !== 'master' &&
        correction.targetId !== 'mix' &&
        this.options.onEditTarget
      ) {
        const edit = el('button', 'ai-edit', 'Edit');
        edit.title = `Close ${ASSISTANT_NAME} and select “${correction.targetName ?? 'this track'}” in the rack`;
        edit.addEventListener('click', () => this.options.onEditTarget?.(correction.targetId as string));
        actions.appendChild(edit);
      }
      const apply = el('button', 'ai-apply', done ? 'Applied ✓' : 'Apply');
      apply.disabled = done;
      apply.addEventListener('click', () => this.apply([correction]));
      actions.appendChild(apply);
      head.appendChild(actions);
      card.append(head, el('div', 'ai-corr-title', correction.title), el('div', 'ai-corr-detail', correction.detail));
      host.appendChild(card);
    }
  }

  private renderScan(host: HTMLElement): void {
    const rows = this.scan ?? [];
    if (!rows.length) return;
    const list = el('div', 'scan-list');
    list.appendChild(el('div', 'section-title', `Every track (${rows.length})`));
    for (const row of rows) {
      const line = el('div', 'scan-row');
      const info = el('div', 'scan-info');
      info.append(
        el('strong', '', row.name),
        el(
          'span',
          'scan-meta',
          row.analysis.stats.silent
            ? 'silent'
            : `${row.analysis.stats.lufs.toFixed(1)} LUFS · ${row.analysis.stats.crestDb.toFixed(0)} dB crest · ${row.analysis.corrections.length} fix${row.analysis.corrections.length === 1 ? '' : 'es'}`,
        ),
      );
      const fix = el('button', 'ai-apply', row.applied ? 'Applied ✓' : row.analysis.corrections.length ? 'Fix' : 'OK');
      fix.disabled = row.applied || row.analysis.corrections.length === 0;
      fix.addEventListener('click', () => {
        this.applying = true;
        try {
          this.store.edit('structure', (project) => {
            for (const correction of row.analysis.corrections) correction.apply(project);
          });
        } finally {
          this.applying = false;
        }
        row.applied = true;
        const count = row.analysis.corrections.length;
        this.status = `${row.name}: ${count} correction${count === 1 ? '' : 's'} applied — Ctrl+Z to undo.`;
        this.render();
      });
      line.append(info, fix);
      list.appendChild(line);
    }
    host.appendChild(list);
  }

  // ------------------------------------------------------------------- help

  private renderHelp(host: HTMLElement): void {
    const search = el('input', 'help-search') as HTMLInputElement;
    search.type = 'search';
    search.placeholder = 'Search help — loudness, VST3, undo, export…';
    search.value = this.query;
    search.setAttribute('aria-label', 'Search help');
    search.addEventListener('input', () => {
      this.query = search.value;
      this.renderTopicList(topicsHost, search.value);
    });
    host.appendChild(search);

    const diagnoses = diagnoseProject(this.store.project, this.store.selectedTrackId);
    const checks = el('section', 'help-checks');
    checks.appendChild(el('div', 'section-title', 'Check my session'));
    const list = el('div', 'help-diag');
    for (const entry of diagnoses) {
      const card = el('div', `help-diag-card is-${entry.severity}`);
      const head = el('div', 'help-diag-head');
      head.appendChild(el('span', `help-dot ${entry.severity}`));
      head.appendChild(el('strong', '', entry.title));
      if (entry.fix && entry.fixLabel) {
        const fix = el('button', 'help-fix', entry.fixLabel);
        fix.addEventListener('click', () => {
          this.store.edit('structure', (project) => entry.fix?.(project));
          this.status = '';
        });
        head.appendChild(fix);
      }
      card.append(head, el('div', 'help-diag-detail', entry.detail));
      list.appendChild(card);
    }
    checks.appendChild(list);
    host.appendChild(checks);

    const topicsHost = el('section', 'help-topics');
    topicsHost.appendChild(el('div', 'section-title', 'Guides'));
    host.appendChild(topicsHost);
    this.renderTopicList(topicsHost, this.query);
  }

  private renderTopicList(host: HTMLElement, query: string): void {
    while (host.childNodes.length > 1) host.removeChild(host.lastChild as Node);
    const matches = searchTopics(query);
    if (!matches.length) {
      host.appendChild(el('div', 'help-empty', `Nothing matches “${query.trim()}”. Try “loudness”, “undo” or “export”.`));
      return;
    }
    for (const group of groupTopics(matches)) {
      host.appendChild(el('div', 'help-group', group.group));
      for (const topic of group.topics) host.appendChild(this.buildTopic(topic));
    }
  }

  private buildTopic(topic: HelpTopic): HTMLElement {
    const details = el('details', 'help-topic') as HTMLDetailsElement;
    details.open = this.openTopics.has(topic.id) || (this.query.trim().length > 0 && searchTopics(this.query).length <= 3);
    details.addEventListener('toggle', () => {
      if (details.open) this.openTopics.add(topic.id);
      else this.openTopics.delete(topic.id);
    });
    const summary = el('summary', 'help-topic-title', topic.title);
    details.appendChild(summary);
    for (const paragraph of topic.body) details.appendChild(el('p', 'help-topic-body', paragraph));
    if (topic.action) {
      const action = el('button', 'help-action', topic.action.label);
      action.addEventListener('click', () => this.runHelpAction(topic.action as HelpAction));
      details.appendChild(action);
    }
    return details;
  }

  private runHelpAction(action: HelpAction): void {
    switch (action.kind) {
      case 'ai-master':
        this.scope = MASTER_SCOPE;
        this.analysis = null;
        this.applied.clear();
        this.status = '';
        this.open('mix');
        break;
      case 'ai-track':
        this.scope = this.store.selectedTrackId || MASTER_SCOPE;
        this.analysis = null;
        this.applied.clear();
        this.status = '';
        this.open('mix');
        break;
      case 'export':
        this.close();
        this.options.onExport?.();
        break;
      case 'rig':
        this.close();
        this.options.onOpenRig?.();
        break;
      case 'remote':
        this.close();
        this.options.onOpenRemote?.();
        break;
      case 'start':
        this.close();
        this.options.onShowStart?.();
        break;
    }
  }

  // ---------------------------------------------------------------- actions

  private async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.analysis = null;
    this.applied.clear();
    this.scan = null;
    const isMaster = this.scope === MASTER_SCOPE;
    const track = this.store.project.tracks.find((t) => t.id === this.scope);
    if (!isMaster && !track) {
      this.busy = false;
      this.status = 'Pick a track first.';
      this.render();
      return;
    }
    this.status = isMaster ? 'Rendering the whole mix and every track…' : `Rendering “${track?.name ?? 'track'}”…`;
    const token = ++this.token;
    this.render();

    try {
      const analysis = isMaster
        ? await analyzeMaster(this.store, MASTER_TARGETS[this.target], this.intensity)
        : await analyzeTrack(this.store, this.scope, this.intensity);
      if (token !== this.token) return;
      this.analysis = analysis;
      this.status = analysis.stats.silent
        ? 'No audio in this range — nothing to correct.'
        : `${analysis.summary} · ${analysis.corrections.length} correction${analysis.corrections.length === 1 ? '' : 's'}`;
    } catch (error) {
      if (token === this.token) this.status = error instanceof Error ? error.message : 'Analysis failed.';
    } finally {
      if (token === this.token) {
        this.busy = false;
        this.render();
      }
    }
  }

  private async scanAll(): Promise<void> {
    if (this.busy) return;
    const tracks = this.store.project.tracks;
    if (!tracks.length) return;
    this.busy = true;
    this.scan = [];
    this.analysis = null;
    this.applied.clear();
    const token = ++this.token;
    try {
      for (let index = 0; index < tracks.length; index++) {
        if (token !== this.token) return;
        const track = tracks[index];
        this.status = `Scanning “${track.name}” (${index + 1}/${tracks.length})…`;
        this.render();
        const analysis = await analyzeTrack(this.store, track.id, this.intensity);
        if (token !== this.token) return;
        this.scan = [...(this.scan ?? []), { trackId: track.id, name: track.name, analysis, applied: false }];
        this.render();
      }
      const total = this.scan.reduce((sum, row) => sum + row.analysis.corrections.length, 0);
      this.status = `Scanned ${tracks.length} tracks · ${total} possible fix${total === 1 ? '' : 'es'}. Apply them per track, or analyze the whole mix next.`;
    } catch (error) {
      if (token === this.token) this.status = error instanceof Error ? error.message : 'Scan failed.';
    } finally {
      if (token === this.token) {
        this.busy = false;
        this.render();
      }
    }
  }

  private apply(corrections: AiCorrection[]): void {
    if (!corrections.length) return;
    for (const correction of corrections) this.applied.add(correction.id);
    this.status = `${corrections.length} change${corrections.length === 1 ? '' : 's'} applied. Edit any value in the rack or console, or use Undo AI change (Ctrl+Z) to take it back.`;
    this.applying = true;
    try {
      this.store.edit('structure', (project) => {
        for (const correction of corrections) correction.apply(project);
      });
    } finally {
      this.applying = false;
    }
  }
}
