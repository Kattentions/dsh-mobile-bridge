window.__ModuleLoader__.load({
  id: 'dsh-mobile-bridge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useState } = React;

    const CSS = `
      .kmb-section { display:flex; flex-direction:column; gap:18px; max-width:720px; padding:8px 0; color:var(--dsw-alias-label-primary) }
      .kmb-title { margin:0; font-size:18px; font-weight:600 }
      .kmb-intro { margin:0; font-size:13px; line-height:1.6; color:var(--dsw-alias-label-secondary) }
      .kmb-group { display:flex; flex-direction:column; gap:8px }
      .kmb-head { margin:0; font-size:12px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--dsw-alias-label-secondary) }
      .kmb-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(232px, 1fr)); gap:12px }
      .kmb-card { min-width:0; box-sizing:border-box; display:flex; flex-direction:column; gap:10px; padding:14px; border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-layer-1) }
      .kmb-cardHead { display:flex; align-items:center; gap:8px; font-size:13px; font-weight:600 }
      .kmb-dot { width:7px; height:7px; border-radius:50%; flex:none; background:var(--dsw-alias-state-idle-primary) }
      .kmb-dot.on { background:var(--dsw-alias-state-success-primary) }
      .kmb-dot.off { background:var(--dsw-alias-state-error-primary) }
      .kmb-status { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--dsw-alias-label-secondary) }
      .kmb-qrBox { align-self:center; padding:10px; border-radius:8px; background:#fff }
      .kmb-qrBox img { display:block; width:168px; height:168px }
      .kmb-hint { margin:0; font-size:12px; line-height:1.5; color:var(--dsw-alias-label-secondary) }
      .kmb-code { margin:0; font-size:12px; line-height:1.6; color:var(--dsw-alias-label-primary) }
      .kmb-code strong { font-size:15px; letter-spacing:1px; font-variant-numeric:tabular-nums }
      .kmb-rows { display:flex; flex-direction:column; gap:0 }
      .kmb-row { display:flex; align-items:center; gap:10px; padding:7px 0; border-top:1px solid var(--dsw-alias-border-l1); font-size:13px }
      .kmb-row:first-child { border-top:0 }
      .kmb-rowLabel { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:2px }
      .kmb-rowName { font-weight:500 }
      .kmb-rowValue { font-size:12px; color:var(--dsw-alias-label-secondary); word-break:break-all }
      .kmb-btn { flex:none; font:inherit; font-size:12px; line-height:1; padding:5px 9px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); background:transparent; color:var(--dsw-alias-label-primary); cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; gap:5px }
      .kmb-btn:hover { background:var(--dsw-alias-bg-layer-2) }
      .kmb-btn.primary { border-color:transparent; background:var(--dsw-alias-brand-primary); color:var(--dsw-alias-bg-base); font-weight:500 }
      .kmb-actions { display:flex; flex-wrap:wrap; gap:8px; align-items:center }
      .kmb-note { margin:0; font-size:12px; line-height:1.6; color:var(--dsw-alias-label-secondary) }
      .kmb-empty { padding:10px 0; font-size:13px; color:var(--dsw-alias-label-secondary) }
    `;

    function StyleTag() {
      return h('style', { 'data-kmb-settings': '' }, CSS);
    }

    function copyText(text) {
      const fallback = () => {
        try {
          const area = document.createElement('textarea');
          area.value = text;
          area.setAttribute('readonly', '');
          area.style.position = 'fixed';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(area);
          return ok;
        } catch (error) {
          return false;
        }
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(text).then(() => true, () => fallback());
        }
      } catch (error) { /* fall through */ }
      return Promise.resolve(fallback());
    }

    function Button(props) {
      const { children, primary, onClick, title } = props;
      return h('button', {
        type: 'button',
        className: 'kmb-btn' + (primary ? ' primary' : ''),
        onClick,
        title: title || undefined,
      }, children);
    }

    function useCopied() {
      const [copied, setCopied] = useState('');
      const copy = useCallback((key, text) => {
        copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(key);
          window.setTimeout(() => setCopied((current) => current === key ? '' : current), 1600);
        });
      }, []);
      return [copied, copy];
    }

    function bridgeState() {
      return fetch('./__ink/pair/state', { cache: 'no-store' })
        .then((response) => response.ok ? response.json() : Promise.reject(new Error('bridge ' + response.status)));
    }

    function DeviceConnectionsSection() {
      const [state, setState] = useState(undefined);
      const [error, setError] = useState('');
      const [refreshing, setRefreshing] = useState(false);
      const [copied, copy] = useCopied();
      const [pairing, setPairing] = useState(null);

      const load = useCallback((manual) => {
        if (manual) setRefreshing(true);
        return bridgeState().then((value) => {
          setState(value);
          setError('');
        }).catch(() => {
          setError('连不上桥的接口，确认 dsh-mobile-bridge 已启用并重启过 DSH。');
        }).finally(() => {
          if (manual) setRefreshing(false);
        });
      }, []);

      useEffect(() => {
        let alive = true;
        load(false);
        const timer = window.setInterval(() => {
          if (!alive || document.hidden) return;
          load(false);
        }, 5000);
        const onFocus = () => load(false);
        window.addEventListener('focus', onFocus);
        return () => {
          alive = false;
          window.clearInterval(timer);
          window.removeEventListener('focus', onFocus);
        };
      }, [load]);

      const networks = useMemo(() => (state && Array.isArray(state.networks) ? state.networks : []), [state]);
      const devices = useMemo(() => (state && Array.isArray(state.devices) ? state.devices : []), [state]);
      const paired = useMemo(() => (state && Array.isArray(state.paired) ? state.paired : []), [state]);
      const first = networks[0];
      /* Prefer a freshly minted pairing URL: the phone redeems it once for its own
         device token. The deep link with the master key stays as a fallback. */
      const pairNetwork = pairing && Array.isArray(pairing.networks) ? pairing.networks.find((entry) => entry && entry.url) : null;
      const qrPayload = pairNetwork && pairNetwork.url ? pairNetwork.url : (first && first.deep ? first.deep : '');
      const qr = qrPayload !== ''
        ? './__ink/pair/qr?d=' + encodeURIComponent(qrPayload)
        : '';
      const app = state && state.app ? state.app : null;
      const running = Boolean(state && state.listening);

      return h('section', { className: 'kmb-section', 'aria-label': '设备互联' },
        h(StyleTag, null),
        h('h2', { className: 'kmb-title' }, '设备互联'),
        h('p', { className: 'kmb-intro' },
          '让手机连上这台电脑上的 DSH。两边要在同一个网络：同一个 Wi-Fi，或者蒲公英、Tailscale 这类虚拟局域网。'),
        h('div', { className: 'kmb-status' },
          h('span', { className: 'kmb-dot ' + (running ? 'on' : 'off'), 'aria-hidden': 'true' }),
          h('span', null, running
            ? '局域网桥正在运行 · 端口 ' + state.port
            : (state === undefined && error === '' ? '正在读取桥状态…' : '桥没有在运行，重启 DSH 后再看')),
          h('span', { style: { flex: '1' } }),
          h(Button, { onClick: () => load(true), title: '重新读取状态' }, refreshing ? '刷新中…' : '刷新'),
        ),
        error !== '' ? h('p', { className: 'kmb-note', style: { color: 'var(--dsw-alias-state-warn-primary)' } }, error) : null,

        h('section', { className: 'kmb-group' },
          h('h3', { className: 'kmb-head' }, '配对'),
          h('div', { className: 'kmb-grid' },
            h('div', { className: 'kmb-card' },
              h('div', { className: 'kmb-cardHead' }, '扫码配对'),
              qr !== ''
                ? h('div', { className: 'kmb-qrBox' }, h('img', { src: qr, alt: '配对二维码', width: 168, height: 168 }))
                : h('div', { className: 'kmb-empty' }, '桥还没有公布可用地址，先确认电脑有局域网连接。'),
              h('div', { className: 'kmb-actions' },
                h(Button, { onClick: () => {
                  fetch('./__ink/pair/code', { cache: 'no-store' })
                    .then((response) => response.ok ? response.json() : Promise.reject(new Error('code ' + response.status)))
                    .then((value) => setPairing(value))
                    .catch(() => setError('生成配对码失败，稍后再试。'));
                } }, pairing ? '换一个配对码' : '生成配对码'),
                pairing ? h(Button, { onClick: () => copy('code', pairing.code) }, copied === 'code' ? '已复制' : '复制配对码') : null,
              ),
              pairing
                ? h('p', { className: 'kmb-code' }, '配对码 ', h('strong', null, pairing.code), '（2 分钟内有效，只能用一次）')
                : h('p', { className: 'kmb-hint' }, '点「生成配对码」后，用手机 App 的「扫码配对」扫上面的码；配对码一次有效，过期就再生成一个。'),
            ),
            h('div', { className: 'kmb-card' },
              h('div', { className: 'kmb-cardHead' }, '连接地址'),
              networks.length === 0
                ? h('div', { className: 'kmb-empty' }, '没有可用地址')
                : h('div', { className: 'kmb-rows' }, networks.map((entry, index) => h('div', { className: 'kmb-row', key: entry.address + index },
                  h('div', { className: 'kmb-rowLabel' },
                    h('span', { className: 'kmb-rowName' }, entry.name || '网络 ' + (index + 1)),
                    h('span', { className: 'kmb-rowValue' }, entry.address),
                  ),
                  h(Button, { onClick: () => copy('url' + index, entry.url), title: '复制带密钥的地址' },
                    copied === 'url' + index ? '已复制' : '复制链接'),
                ))),
              h('div', { className: 'kmb-actions' },
                h('a', { className: 'kmb-btn', href: './__ink/pair', target: '_blank', rel: 'noreferrer' }, '打开配对页'),
                h(Button, { onClick: () => copy('key', state && state.key ? state.key : '') }, copied === 'key' ? '已复制' : '复制密钥'),
              ),
              h('p', { className: 'kmb-hint' }, '地址会随 Wi-Fi 或 VPN 变化；换网络后回到这里重新扫码。'),
            ),
          ),
        ),

        h('section', { className: 'kmb-group' },
          h('h3', { className: 'kmb-head' }, '手机 App'),
          h('div', { className: 'kmb-card' },
            h('div', { className: 'kmb-row' },
              h('div', { className: 'kmb-rowLabel' },
                h('span', { className: 'kmb-rowName' }, 'DSH 手机壳'),
                h('span', { className: 'kmb-rowValue' }, app
                  ? '当前 ' + app.version + '（versionCode ' + app.versionCode + '）'
                  : '安装包还没构建'),
              ),
              h('a', { className: 'kmb-btn primary', href: './__ink/app', target: '_blank', rel: 'noreferrer' }, '下载安装',
              ),
            ),
            h('p', { className: 'kmb-hint' }, '手机和电脑连上同一个网络后，在手机浏览器里打开这个下载页也能装。以后 App 里「检查更新」会读同一个版本清单。'),
          ),
        ),

        h('section', { className: 'kmb-group' },
          h('h3', { className: 'kmb-head' }, '已配对设备'),
          paired.length === 0
            ? h('p', { className: 'kmb-empty' }, '还没有已配对设备。生成配对码、用手机扫一次之后，这里会出现一台记录。')
            : h('div', { className: 'kmb-rows' },
              paired.map((device) => h('div', { className: 'kmb-row', key: device.id },
                h('div', { className: 'kmb-rowLabel' },
                  h('span', { className: 'kmb-rowName' }, device.name || '手机'),
                  h('span', { className: 'kmb-rowValue' }, '最近使用 ' + when(device.lastSeenAt)),
                ),
                h(Button, { onClick: () => {
                  fetch('./__ink/pair/revoke', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ id: device.id }),
                  }).then(() => load(false)).catch(() => setError('撤销设备失败，稍后再试。'));
                }, title: '撤销后这台手机需要重新配对' }, '撤销'),
              )),
            ),
        ),

        h('section', { className: 'kmb-group' },
          h('h3', { className: 'kmb-head' }, '最近连接的设备'),
          devices.length === 0
            ? h('p', { className: 'kmb-empty' }, '还没有设备连过。配对成功、手机打开页面之后这里会出现记录。')
            : h('div', { className: 'kmb-rows' },
              devices.map((device, index) => h('div', { className: 'kmb-row', key: (device.ip || '') + index },
                h('div', { className: 'kmb-rowLabel' },
                  h('span', { className: 'kmb-rowName' }, device.ip || '未知地址'),
                  h('span', { className: 'kmb-rowValue' }, shortAgent(device.ua) + ' · ' + when(device.lastAt)),
                ),
                h('span', { className: 'kmb-rowValue' }, device.count > 1 ? (device.count + ' 次请求') : ''),
              )),
            ),
        ),

        h('p', { className: 'kmb-note' },
          '桥只对局域网开放，别把 6080 端口映射到公网。想一次性让所有已配对设备失效，删掉 ',
          h('code', null, '~/.dsh/mobile-bridge.key'),
          ' 再重启 DSH；只想断某一台手机，用上面的「撤销」。'),
      );
    }

    function shortAgent(ua) {
      const text = String(ua || '');
      if (/DSHHarness/i.test(text)) return 'DSH App';
      if (/Android/i.test(text)) {
        const match = text.match(/Android [\d.]+/i);
        return 'Android' + (match ? ' ' + match[0].replace(/Android /i, '') : '');
      }
      if (/iPhone|iPad/i.test(text)) return 'iOS';
      if (/Windows/i.test(text)) return 'Windows';
      if (/Macintosh/i.test(text)) return 'macOS';
      if (text === '') return '未知浏览器';
      return '浏览器';
    }

    function when(at) {
      const time = Number(at);
      if (!Number.isFinite(time)) return '';
      const delta = Date.now() - time;
      if (delta < 60_000) return '刚刚';
      if (delta < 3_600_000) return Math.floor(delta / 60_000) + ' 分钟前';
      if (delta < 86_400_000) return Math.floor(delta / 3_600_000) + ' 小时前';
      return new Date(time).toLocaleDateString();
    }

    function DeviceConnectionsIcon(props) {
      const size = props && Number(props.size) || 16;
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': true,
        style: { display: 'block', color: props && props.active ? 'var(--dsw-alias-brand-primary)' : 'currentColor' },
      },
        h('rect', { x: 3.2, y: 1.6, width: 9.6, height: 12.8, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
        h('circle', { cx: 8, cy: 11.4, r: 0.9, fill: 'currentColor' }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => {
          const disposers = [];
          try {
            disposers.push(ctx.slots.register({ name: 'settings.section', id: 'mobile-bridge', order: 15, label: () => '设备互联' }, DeviceConnectionsSection));
          } catch (error) { /* section cannot register on this build */ }
          try {
            disposers.push(ctx.slots.register({ name: 'settings.section.icon', key: 'mobile-bridge' }, DeviceConnectionsIcon));
          } catch (error) { /* icon is optional */ }
          return () => {
            for (const dispose of disposers) {
              try { dispose(); } catch (error) { /* already gone */ }
            }
          };
        });
      },
    };
  },
});
