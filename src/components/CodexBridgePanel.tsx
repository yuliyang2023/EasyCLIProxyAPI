import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { useI18n } from '../i18n';
import { Switch } from './Switch';
import { controlCodexBridge, getCodexBridge, saveCodexBridge, syncCodexBridgeProvider,
  type CodexBridgeConfig, type CodexBridgeStatus } from '../services/codexBridge';
import './CodexBridgePanel.css';

export function CodexBridgePanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<CodexBridgeStatus | null>(null);
  const [draft, setDraft] = useState<CodexBridgeConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [visible, setVisible] = useState(false);
  const mounted = useRef(false);
  const revision = useRef(0);

  const refresh = useCallback(async () => {
    const current = revision.current;
    try {
      const value = await getCodexBridge();
      if (!mounted.current || current !== revision.current) return;
      setStatus(value);
      setDraft(draft => draft ?? value.config);
    } catch (error) {
      if (mounted.current && current === revision.current) setError(String(error));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [refresh]);

  const dirty = Boolean(draft && status && JSON.stringify(draft) !== JSON.stringify(status.config));
  const change = <K extends keyof CodexBridgeConfig,>(key: K, value: CodexBridgeConfig[K]) => {
    setDraft(current => current ? { ...current, [key]: value } : current);
    setNotice('');
  };
  const act = async (operation: () => Promise<void>) => {
    revision.current++;
    setBusy(true); setError(''); setNotice('');
    try { await operation(); }
    catch (error) { if (mounted.current) setError(String(error)); }
    finally {
      if (mounted.current) { setBusy(false); await refresh(); }
    }
  };
  const save = () => act(async () => {
    if (!draft) return;
    const value = await saveCodexBridge(draft);
    if (!mounted.current) return;
    setStatus(value); setDraft(value.config); setNotice(t('bridge.saved'));
    try { await syncCodexBridgeProvider(value.config, true); }
    catch { if (mounted.current) setNotice(t('bridge.syncFailed')); }
  });
  const control = (action: 'start' | 'stop' | 'restart') => act(async () => {
    if (dirty && action !== 'stop') throw new Error(t('bridge.unsaved'));
    const value = await controlCodexBridge(action);
    if (mounted.current) setStatus(value);
  });

  return <section className="panel codex-bridge-panel" aria-label={t('bridge.title')}>
    <header className="codex-bridge-heading">
      <div><h2>{t('bridge.title')}</h2><p>{t('bridge.description')}</p></div>
      <span className="state-pill">{status ? t(status.running ? 'bridge.running' : 'bridge.stopped') : '—'}{status?.pid ? ` · PID ${status.pid}` : ''}</span>
      <button className="secondary-button compact-button" type="button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} />{t('bridge.refresh')}</button>
    </header>
    {error || status?.lastError ? <p className="codex-bridge-error" role="alert">{error || status?.lastError}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
    {!draft ? <p>{t('bridge.dependencies')}</p> : <>
      <div className="codex-bridge-switches">
        <Switch label={t('bridge.enabled')} checked={draft.enabled} disabled={busy} onChange={event => change('enabled', event.currentTarget.checked)} />
        <Switch label={t('bridge.autoStart')} checked={draft.startOnLaunch} disabled={busy || !draft.enabled} onChange={event => change('startOnLaunch', event.currentTarget.checked)} />
      </div>
      <div className="codex-bridge-fields">
        <label>{t('bridge.port')}<input type="number" min={1} max={65535} value={draft.port} disabled={busy} onChange={event => change('port', Number(event.currentTarget.value))} /></label>
        <label className="codex-bridge-key">{t('bridge.apiKey')}
          <span className="codex-bridge-key-controls"><input type={visible ? 'text' : 'password'} autoComplete="new-password" value={draft.apiKey} disabled={busy} onChange={event => change('apiKey', event.currentTarget.value)} />
            <button type="button" className="icon-button" aria-label={t(visible ? 'bridge.hideKey' : 'bridge.showKey')} onClick={() => setVisible(value => !value)}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</button>
            <button type="button" className="secondary-button compact-button" disabled={busy} onClick={() => change('apiKey', `cb_${Array.from(crypto.getRandomValues(new Uint8Array(24)), value => value.toString(16).padStart(2, '0')).join('')}`)}>{t('bridge.generateKey')}</button>
          </span><small>{t('bridge.keyHint')}</small>
        </label>
        <label>{t('bridge.nodePath')}<input value={draft.nodePath} placeholder={t('bridge.detect')} disabled={busy} onChange={event => change('nodePath', event.currentTarget.value)} /></label>
        <label>{t('bridge.codexPath')}<input value={draft.codexPath} placeholder={t('bridge.detect')} disabled={busy} onChange={event => change('codexPath', event.currentTarget.value)} /></label>
        <label className="codex-bridge-wide">{t('bridge.codexHome')}<input value={draft.codexHome} placeholder={t('bridge.homeHint')} disabled={busy} onChange={event => change('codexHome', event.currentTarget.value)} /></label>
        <label className="codex-bridge-wide">{t('bridge.endpoint')}<span className="codex-bridge-key-controls"><input readOnly value={status?.baseUrl ?? ''} /><button type="button" className="icon-button" aria-label={t('bridge.copy')} onClick={() => void act(async () => { await navigator.clipboard.writeText(status?.baseUrl ?? ''); })}><Copy size={17} /></button></span></label>
      </div>
      <p className="codex-bridge-hint">{t('bridge.dependencies')}{status && !status.nodeAvailable ? ` ${t('bridge.nodeMissing')}.` : ''}{status && !status.codexAvailable ? ` ${t('bridge.codexMissing')}.` : ''}</p>
      <div className="codex-bridge-actions">
        <button type="button" className="primary-button" disabled={busy || !Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535 || (draft.enabled && !draft.apiKey.trim())} onClick={() => void save()}>{t('bridge.save')}</button>
        <button type="button" className="secondary-button" disabled={busy || !status?.config.enabled || dirty} onClick={() => void control(status?.running ? 'restart' : 'start')}>{t(status?.running ? 'bridge.restart' : 'bridge.start')}</button>
        <button type="button" className="secondary-button" disabled={busy || !status?.running} onClick={() => void control('stop')}>{t('bridge.stop')}</button>
        <button type="button" className="secondary-button" disabled={busy || !status?.running || dirty} onClick={() => void act(async () => { if (!status) return; await syncCodexBridgeProvider(status.config); setNotice(t('bridge.synced')); })}>{t('bridge.sync')}</button>
      </div>
      <p className="codex-bridge-hint">{t('bridge.runtimeHint')}</p>
      <p className="codex-bridge-hint">{t('bridge.stats')}</p>
    </>}
  </section>;
}
