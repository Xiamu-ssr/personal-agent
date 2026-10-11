import Foundation

enum BrowserScripts {
    /// Runs in WKContentWorld.defaultClient: page scripts cannot replace the ref map or observer.
    static let install = #"""
    (() => {
      if (window.__doudou && window.__doudou.document === document) return;
      const state = {document, refs: new Map(), ids: new WeakMap(), next: 1, changed: performance.now()};
      const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
      const quoted = value => JSON.stringify(clean(value));
      const visible = el => {
        if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
        return style.display === 'contents' || el.getClientRects().length > 0;
      };
      const role = el => {
        const explicit = clean(el.getAttribute('role')).split(' ')[0];
        if (explicit && explicit !== 'none' && explicit !== 'presentation') return explicit;
        if (explicit) return '';
        const tag = el.localName;
        if (tag === 'input') {
          const type = el.type;
          if (type === 'hidden') return '';
          if (['button','submit','reset','image'].includes(type)) return 'button';
          if (['checkbox','radio'].includes(type)) return type;
          if (type === 'range') return 'slider';
          if (type === 'number') return 'spinbutton';
          return type === 'search' ? 'searchbox' : 'textbox';
        }
        if (/^h[1-6]$/.test(tag)) return 'heading';
        if (tag === 'a') return el.hasAttribute('href') ? 'link' : '';
        if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
        if (tag === 'section' || tag === 'form') return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? (tag === 'form' ? 'form' : 'region') : '';
        const roles = {button:'button',textarea:'textbox',summary:'button',nav:'navigation',main:'main',
          header:'banner',footer:'contentinfo',aside:'complementary',article:'article',ul:'list',ol:'list',
          li:'listitem',table:'table',thead:'rowgroup',tbody:'rowgroup',tfoot:'rowgroup',tr:'row',
          td:'cell',th:el.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader',fieldset:'group',
          dialog:'dialog',img:'img',progress:'progressbar',meter:'meter',option:'option',iframe:'iframe'};
        return roles[tag] || (el.isContentEditable ? 'textbox' : (el.tabIndex >= 0 ? 'generic' : ''));
      };
      const name = (el, r) => {
        const labelled = clean(el.getAttribute('aria-labelledby'));
        if (labelled) {
          const result = clean(labelled.split(' ').map(id => el.getRootNode().getElementById?.(id)?.textContent || document.getElementById(id)?.textContent || '').join(' '));
          if (result) return result;
        }
        if (el.hasAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
        if (el.labels && el.labels.length) return clean(Array.from(el.labels).map(label => label.innerText).join(' '));
        if (el.localName === 'img') return clean(el.alt);
        if (el.localName === 'input' && r === 'button') return clean(el.value || el.alt || el.title);
        if (['textbox','searchbox','combobox','listbox','slider','spinbutton'].includes(r)) return clean(el.getAttribute('placeholder') || el.title);
        if (['button','link','heading','option','cell','columnheader','rowheader'].includes(r)) return clean(el.innerText || el.textContent || el.title);
        if (el.localName === 'fieldset') return clean(el.querySelector('legend')?.textContent);
        return clean(el.title);
      };
      const interactiveRoles = new Set(['button','link','textbox','searchbox','checkbox','radio','combobox','listbox',
        'option','slider','spinbutton','switch','tab','menuitem','menuitemcheckbox','menuitemradio','treeitem']);
      const isInteractive = (el, r) => interactiveRoles.has(r) || el.tabIndex >= 0 || el.isContentEditable;
      const status = (el, r) => {
        const values = [];
        const attr = (key, label = key.replace('aria-', '')) => {
          if (el.hasAttribute(key)) values.push(label + '=' + clean(el.getAttribute(key)));
        };
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') values.push('disabled');
        if (el.required) values.push('required');
        if (el.readOnly) values.push('readonly');
        if (r === 'heading') values.push('level=' + (el.getAttribute('aria-level') || el.localName.slice(1)));
        if (r === 'checkbox' || r === 'radio') {
          values.push('checked=' + (el.indeterminate ? 'mixed' : (el.getAttribute('aria-checked') ?? String(el.checked))));
        } else attr('aria-checked');
        for (const key of ['aria-expanded','aria-selected','aria-pressed','aria-current','aria-required','aria-readonly','aria-busy']) attr(key);
        if (document.activeElement === el) values.push('focused');
        if (['textbox','searchbox','spinbutton','slider','combobox'].includes(r) && 'value' in el && el.value) {
          values.push('value=' + (el.type === 'password' ? '"[隐藏]"' : quoted(el.value).slice(0, 250)));
        }
        return values.map(value => '[' + value + ']').join(' ');
      };
      state.snapshot = () => {
        state.refs = new Map();
        const lines = [], limit = 12000, marker = '\n[已截断：页面结构超过 12000 字]';
        let length = 0, truncated = false, visits = 0;
        const line = (depth, text) => {
          const value = '  '.repeat(Math.min(depth, 40)) + '- ' + text;
          if (length + value.length + 1 > limit - marker.length) { truncated = true; return false; }
          lines.push(value); length += value.length + 1; return true;
        };
        const visit = (node, depth) => {
          if (truncated) return;
          if (++visits > 50000) { truncated = true; return; }
          if (node.nodeType === Node.TEXT_NODE) {
            const value = clean(node.textContent);
            if (value) line(depth, 'text ' + quoted(value));
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const el = node;
          if (['script','style','noscript','template'].includes(el.localName) || !visible(el)) return;
          const r = role(el), n = name(el, r);
          if (r === 'img' && !n) return;
          const emitted = Boolean(r && !(r === 'generic' && !n && el.tabIndex < 0));
          if (emitted) {
            let text = r + (n ? ' ' + quoted(n) : '');
            const states = status(el, r);
            if (states) text += ' ' + states;
            if (isInteractive(el, r)) {
              let ref = state.ids.get(el);
              if (!ref) { ref = 'e' + state.next++; state.ids.set(el, ref); }
              state.refs.set(ref, el);
              text += ' [ref=' + ref + ']';
            }
            if (!line(depth, text)) return;
          }
          if (['input','textarea','select','img'].includes(el.localName) || ['button','link','heading','option'].includes(r)) return;
          const nextDepth = depth + (emitted ? 1 : 0);
          if (el.localName === 'iframe') {
            // Same-origin frames can be read. Cross-origin frames retain their boundary in the tree.
            try { if (el.contentDocument?.body) visit(el.contentDocument.body, nextDepth); } catch (_) {}
            return;
          }
          const children = el.localName === 'slot' && el.assignedNodes().length ? el.assignedNodes() :
            (el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes);
          for (const child of children) visit(child, nextDepth);
        };
        if (document.body) visit(document.body, 0);
        return lines.join('\n') + (truncated ? marker : '');
      };
      state.target = ref => {
        const el = state.refs.get(ref);
        if (!el || !el.isConnected || !visible(el)) throw new Error('ref 已失效，请重新 snapshot');
        if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('[inert]')) throw new Error('这个元素不可操作');
        el.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
        let rect = el.getBoundingClientRect();
        let view = el.ownerDocument.defaultView;
        let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
        let right = Math.min(view.innerWidth, rect.right), bottom = Math.min(view.innerHeight, rect.bottom);
        while (view !== window) {
          const frame = view.frameElement;
          if (!frame) throw new Error('无法定位跨域 frame');
          const frameRect = frame.getBoundingClientRect();
          left += frameRect.left + frame.clientLeft; right += frameRect.left + frame.clientLeft;
          top += frameRect.top + frame.clientTop; bottom += frameRect.top + frame.clientTop;
          view = frame.ownerDocument.defaultView;
        }
        left = Math.max(0, left); top = Math.max(0, top);
        right = Math.min(innerWidth, right); bottom = Math.min(innerHeight, bottom);
        if (right <= left || bottom <= top) throw new Error('元素不在可见区域');
        // Reject covered targets instead of clicking a different control.
        const hit = el.ownerDocument.elementFromPoint((rect.left + rect.right)/2, (rect.top + rect.bottom)/2);
        if (hit && hit !== el && !el.contains(hit) && !hit.contains(el) && !el.getRootNode().host) throw new Error('元素被遮挡，请重新 snapshot');
        return {x:left,y:top,width:right-left,height:bottom-top,viewportWidth:innerWidth,viewportHeight:innerHeight};
      };
      new MutationObserver(() => { state.changed = performance.now(); }).observe(document.documentElement || document,
        {subtree:true,childList:true,attributes:true,characterData:true});
      state.idle = () => performance.now() - state.changed;
      window.__doudou = state;
    })()
    """#

    static let snapshot = "window.__doudou.snapshot()"
    static let idle = "window.__doudou.idle()"
    static let target = "return window.__doudou.target(ref)"
}
