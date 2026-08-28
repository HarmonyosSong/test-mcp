import { Select } from '@arco-design/web-react';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  Link2,
  LoaderCircle,
  Power,
  RefreshCw,
  Save,
  ShieldCheck,
  TestTube2,
  X,
} from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type {
  ModelConfigInput,
  ModelConnectionResult,
  ModelProviderPreset,
  ModelStatus,
} from '../types';

interface ModelSettingsDialogProps {
  providers: ModelProviderPreset[];
  status: ModelStatus;
  onClose: () => void;
  onChanged: (status: ModelStatus, message: string) => void;
}

type PendingAction = 'test' | 'save' | 'disable' | null;

export function ModelSettingsDialog({
  providers,
  status,
  onClose,
  onChanged,
}: ModelSettingsDialogProps) {
  const initialProvider = status.provider || providers[0]?.id || 'custom';
  const initialPreset = providers.find((item) => item.id === initialProvider);
  const [providerId, setProviderId] = useState(initialProvider);
  const [modelName, setModelName] = useState(
    status.model_name || initialPreset?.default_model || '',
  );
  const [baseUrl, setBaseUrl] = useState(status.base_url || initialPreset?.base_url || '');
  const [apiKey, setApiKey] = useState('');
  const [noApiKey, setNoApiKey] = useState(
    status.provider === 'custom' && !status.api_key_configured,
  );
  const [showApiKey, setShowApiKey] = useState(false);
  const [relaxedCompatibility, setRelaxedCompatibility] = useState(
    status.compatibility_mode === 'relaxed',
  );
  const [pending, setPending] = useState<PendingAction>(null);
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<ModelConnectionResult | null>(null);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  const provider = useMemo(
    () => providers.find((item) => item.id === providerId),
    [providerId, providers],
  );
  const canReuseKey =
    status.api_key_configured &&
    status.provider === providerId &&
    status.base_url === (baseUrl.trim() || provider?.base_url || null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !pending) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, pending]);

  const selectProvider = (nextId: string) => {
    const next = providers.find((item) => item.id === nextId);
    setProviderId(nextId);
    setBaseUrl(next?.base_url || '');
    setModelName(next?.default_model || '');
    setNoApiKey(nextId === 'custom' && !next?.requires_api_key);
    setApiKey('');
    setError('');
    setTestResult(null);
    setRelaxedCompatibility(false);
    setAvailableModels([]);
  };

  const fetchModels = async () => {
    setLoadingModels(true);
    setError('');
    try {
      const models = await api.probeModels({
        provider: providerId,
        base_url: baseUrl.trim() || undefined,
        api_key: noApiKey || !apiKey.trim() ? undefined : apiKey.trim(),
        no_api_key: noApiKey,
      });
      setAvailableModels(models);
      if (models.length === 0) setError('该接口返回了空的模型列表，请手动输入模型 ID。');
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : '获取模型列表失败，请手动输入模型 ID。',
      );
    } finally {
      setLoadingModels(false);
    }
  };

  const payload = (): ModelConfigInput => ({
    provider: providerId,
    model_name: modelName.trim(),
    base_url: baseUrl.trim() || undefined,
    api_key: noApiKey || !apiKey.trim() ? undefined : apiKey.trim(),
    no_api_key: noApiKey,
    compatibility_mode: relaxedCompatibility ? 'relaxed' : 'standard',
  });

  const runTest = async () => {
    setPending('test');
    setError('');
    setTestResult(null);
    try {
      setTestResult(await api.testModel(payload()));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '模型连接测试失败。');
    } finally {
      setPending(null);
    }
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!modelName.trim()) {
      setError('请填写或选择模型名称。');
      return;
    }
    setPending('save');
    setError('');
    try {
      const nextStatus = await api.configureModel(payload());
      setApiKey('');
      onChanged(nextStatus, `${nextStatus.provider_name} · ${nextStatus.model_name} 已启用。`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '模型配置保存失败。');
    } finally {
      setPending(null);
    }
  };

  const disable = async () => {
    setPending('disable');
    setError('');
    try {
      const nextStatus = await api.disableModel();
      setApiKey('');
      onChanged(nextStatus, '已切换为 Demo Engine。');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '停用模型失败。');
    } finally {
      setPending(null);
    }
  };

  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <section
        className="model-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-settings-title"
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow">MODEL GATEWAY</span>
            <h2 id="model-settings-title">模型接入</h2>
          </div>
          <button
            className="icon-button light"
            type="button"
            onClick={onClose}
            disabled={Boolean(pending)}
            title="关闭"
            aria-label="关闭模型设置"
          >
            <X size={19} />
          </button>
        </header>

        <form onSubmit={(event) => void save(event)}>
          <div className={`model-current-state ${status.configured ? 'configured' : ''}`}>
            {status.configured ? <Power size={17} /> : <Link2 size={17} />}
            <div>
              <span>{status.configured ? '当前已启用' : '当前使用 Demo Engine'}</span>
              <strong>
                {status.configured
                  ? `${status.provider_name} · ${status.model_name}`
                  : '未向外部模型发送诊断数据'}
              </strong>
            </div>
            {status.source === 'environment' && <small>ENV</small>}
            {status.source === 'persisted' && <small>已保存</small>}
          </div>

          <div className="protocol-row">
            <span>协议</span>
            <strong>OpenAI-compatible Chat Completions</strong>
          </div>

          <div className="model-form-grid">
            <label className="form-field">
              <span>供应商</span>
              <select value={providerId} onChange={(event) => selectProvider(event.target.value)}>
                {providers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="form-field">
              <span>
                模型名称
                <button
                  type="button"
                  className="fetch-models-button"
                  onClick={() => void fetchModels()}
                  disabled={loadingModels || Boolean(pending) || !baseUrl.trim()}
                  title="调用供应商 GET /models 拉取可用模型"
                >
                  {loadingModels ? (
                    <LoaderCircle className="spin" size={12} />
                  ) : (
                    <RefreshCw size={12} />
                  )}
                  获取模型列表
                </button>
              </span>
              <Select
                showSearch
                allowCreate
                value={modelName}
                onChange={(value) => {
                  setModelName(String(value));
                  setTestResult(null);
                }}
                options={availableModels.length > 0
                  ? availableModels
                  : (provider?.suggested_models ?? [])}
                placeholder={provider?.default_model || '输入或选择服务端模型 ID'}
              />
            </label>
          </div>

          <label className="form-field path-field">
            <span>Base URL</span>
            <div>
              <Link2 size={16} />
              <input
                value={baseUrl}
                onChange={(event) => {
                  setBaseUrl(event.target.value);
                  setTestResult(null);
                }}
                placeholder="https://provider.example.com/v1"
                inputMode="url"
                required
              />
            </div>
          </label>

          {provider?.note && <p className="provider-note">{provider.note}</p>}

          <label className="form-field">
            <span>
              API Key
              {canReuseKey && <small> 已在后端配置，留空继续使用</small>}
            </span>
            <div className="secret-input">
              <ShieldCheck size={16} />
              <input
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setTestResult(null);
                }}
                type={showApiKey ? 'text' : 'password'}
                placeholder={canReuseKey ? '已配置' : '输入服务端 API Key'}
                autoComplete="new-password"
                disabled={noApiKey}
              />
              <button
                type="button"
                onClick={() => setShowApiKey((current) => !current)}
                title={showApiKey ? '隐藏密钥' : '显示密钥'}
                aria-label={showApiKey ? '隐藏 API Key' : '显示 API Key'}
                disabled={noApiKey}
              >
                {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </label>

          {!provider?.requires_api_key && (
            <label className="model-checkbox">
              <input
                type="checkbox"
                checked={noApiKey}
                onChange={(event) => {
                  setNoApiKey(event.target.checked);
                  setApiKey('');
                  setTestResult(null);
                }}
              />
              <span>无需 API Key（仅用于本地 Ollama、vLLM 等可信服务）</span>
            </label>
          )}

          <label className="model-checkbox">
            <input
              type="checkbox"
              checked={relaxedCompatibility}
              onChange={(event) => {
                setRelaxedCompatibility(event.target.checked);
                setTestResult(null);
              }}
            />
            <span>宽松兼容模式（内联 JSON Schema，并关闭 strict 工具定义限制）</span>
          </label>

          <div className="credential-note">
            <ShieldCheck size={16} />
            <span>
              密钥仅保存于本机后端（.data/model-config.json，仅本机账户可读），
              不写入浏览器、本地案例或接口响应。
            </span>
          </div>

          {testResult && (
            <div className="model-test-result" role="status">
              <CheckCircle2 size={17} />
              <span>
                连接成功 · {testResult.latency_ms} ms · {testResult.response_preview || 'OK'}
              </span>
            </div>
          )}

          {error && (
            <div className="form-error" role="alert">
              <AlertTriangle size={16} />
              <span>{error}</span>
            </div>
          )}

          <footer className="dialog-actions model-dialog-actions">
            {status.configured && (
              <button
                className="danger-text-button"
                type="button"
                onClick={() => void disable()}
                disabled={Boolean(pending)}
              >
                {pending === 'disable' ? <LoaderCircle className="spin" size={16} /> : <Power size={16} />}
                停用模型
              </button>
            )}
            <span className="dialog-action-spacer" />
            <button
              className="secondary-button"
              type="button"
              onClick={() => void runTest()}
              disabled={Boolean(pending) || !modelName.trim() || !baseUrl.trim()}
            >
              {pending === 'test' ? <LoaderCircle className="spin" size={16} /> : <TestTube2 size={16} />}
              测试连接
            </button>
            <button className="primary-button" type="submit" disabled={Boolean(pending)}>
              {pending === 'save' ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
              保存并启用
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
