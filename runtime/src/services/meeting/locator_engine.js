async (input, userFn) => {
  const { steps, op } = input;

  const normalize = (value) =>
    String(value == null ? '' : value)
      .replace(/[​­]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const styleOf = (el) => {
    try {
      return el.ownerDocument.defaultView.getComputedStyle(el);
    } catch (e) {
      return null;
    }
  };
  const parentOf = (node) => {
    if (node.parentElement) return node.parentElement;
    const parent = node.parentNode;
    return parent && parent.nodeType === 11 && parent.host ? parent.host : null;
  };

  const shadowRootsUnder = (root, out) => {
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      const shadow = all[i].shadowRoot;
      if (shadow) {
        out.push(shadow);
        shadowRootsUnder(shadow, out);
      }
    }
    return out;
  };
  const queryDeep = (root, selector) => {
    const out = Array.from(root.querySelectorAll(selector));
    for (const shadow of shadowRootsUnder(root, [])) {
      const found = shadow.querySelectorAll(selector);
      for (let i = 0; i < found.length; i++) out.push(found[i]);
    }
    return out;
  };

  const isVisibleTextNode = (node) => {
    const range = node.ownerDocument.createRange();
    range.selectNode(node);
    const rect = range.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const isStyleVisible = (el, style) => {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return false;
    return !style || style.visibility === 'visible';
  };
  const isVisible = (el) => {
    const style = styleOf(el);
    if (!style) return true;
    if (style.display === 'contents') {
      for (let child = el.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1 && isVisible(child)) return true;
        if (child.nodeType === 3 && isVisibleTextNode(child)) return true;
      }
      return false;
    }
    if (!isStyleVisible(el, style)) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const isHiddenForAria = (el) => {
    const tag = el.nodeName;
    if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return true;
    const style = styleOf(el);
    if (style && style.display === 'contents' && tag !== 'SLOT') {
      let shown = false;
      for (let child = el.firstChild; child && !shown; child = child.nextSibling) {
        if (child.nodeType === 1 && !isHiddenForAria(child)) shown = true;
        if (child.nodeType === 3 && isVisibleTextNode(child)) shown = true;
      }
      if (!shown) return true;
    } else {
      const optionInSelect = tag === 'OPTION' && !!el.closest('select');
      if (!optionInSelect && tag !== 'SLOT' && !isStyleVisible(el, style)) return true;
    }
    for (let node = el; node; node = parentOf(node)) {
      if ((node.getAttribute('aria-hidden') || '').toLowerCase() === 'true') return true;
    }
    return false;
  };

  const kValidRoles = new Set([
    'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption',
    'cell', 'checkbox', 'code', 'columnheader', 'combobox', 'complementary', 'contentinfo',
    'definition', 'deletion', 'dialog', 'directory', 'document', 'emphasis', 'feed', 'figure',
    'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list',
    'listbox', 'listitem', 'log', 'main', 'mark', 'marquee', 'math', 'meter', 'menu', 'menubar',
    'menuitem', 'menuitemcheckbox', 'menuitemradio', 'navigation', 'none', 'note', 'option',
    'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup',
    'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status',
    'strong', 'subscript', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term',
    'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
  ]);
  const kGlobalAria = [
    'aria-atomic', 'aria-busy', 'aria-controls', 'aria-current', 'aria-describedby',
    'aria-details', 'aria-dropeffect', 'aria-flowto', 'aria-grabbed', 'aria-hidden',
    'aria-keyshortcuts', 'aria-label', 'aria-labelledby', 'aria-live', 'aria-owns',
    'aria-relevant', 'aria-roledescription',
  ];
  const kLandmarkAncestor =
    'article:not([role]), aside:not([role]), main:not([role]), nav:not([role]), section:not([role]), ' +
    '[role=article], [role=complementary], [role=main], [role=navigation], [role=region]';
  const kInputRoles = {
    button: 'button', checkbox: 'checkbox', image: 'button', number: 'spinbutton', radio: 'radio',
    range: 'slider', reset: 'button', submit: 'button',
  };
  const kNativeDisableable = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'OPTGROUP'];
  const kAriaDisabledRoles = new Set([
    'application', 'button', 'composite', 'gridcell', 'group', 'input', 'link', 'menuitem',
    'scrollbar', 'separator', 'tab', 'checkbox', 'columnheader', 'combobox', 'grid', 'listbox',
    'menu', 'menubar', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'radiogroup', 'row',
    'rowheader', 'searchbox', 'select', 'slider', 'spinbutton', 'switch', 'tablist', 'textbox',
    'toolbar', 'tree', 'treegrid', 'treeitem',
  ]);

  const hasTabIndex = (el) => !Number.isNaN(Number(String(el.getAttribute('tabindex'))));
  const belongsToDisabledFieldSet = (el) => {
    const fieldset = el.closest('FIELDSET[DISABLED]');
    if (!fieldset) return false;
    const legend = fieldset.querySelector(':scope > LEGEND');
    return !legend || !legend.contains(el);
  };
  const isNativelyDisabled = (el) =>
    kNativeDisableable.includes(el.nodeName) &&
    (el.hasAttribute('disabled') ||
      (el.nodeName === 'OPTION' && !!el.closest('OPTGROUP[DISABLED]')) ||
      belongsToDisabledFieldSet(el));
  const isNativelyFocusable = (el) => {
    const tag = el.nodeName;
    if (['BUTTON', 'DETAILS', 'SELECT', 'TEXTAREA'].includes(tag)) return true;
    if (tag === 'A' || tag === 'AREA') return el.hasAttribute('href');
    if (tag === 'INPUT') return !el.hidden;
    return false;
  };
  const isFocusable = (el) => !isNativelyDisabled(el) && (isNativelyFocusable(el) || hasTabIndex(el));
  const hasGlobalAria = (el) => kGlobalAria.some((name) => el.hasAttribute(name));
  const hasExplicitName = (el) => el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby');

  const implicitRole = (el) => {
    switch (el.localName) {
      case 'a':
      case 'area':
        return el.hasAttribute('href') ? 'link' : null;
      case 'article': return 'article';
      case 'aside': return 'complementary';
      case 'blockquote': return 'blockquote';
      case 'button': return 'button';
      case 'caption': return 'caption';
      case 'code': return 'code';
      case 'datalist': return 'listbox';
      case 'dd': return 'definition';
      case 'del': return 'deletion';
      case 'details': return 'group';
      case 'dfn': return 'term';
      case 'dialog': return 'dialog';
      case 'dt': return 'term';
      case 'em': return 'emphasis';
      case 'fieldset': return 'group';
      case 'figure': return 'figure';
      case 'footer':
        return el.parentElement && el.parentElement.closest(kLandmarkAncestor) ? null : 'contentinfo';
      case 'form': return hasExplicitName(el) ? 'form' : null;
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        return 'heading';
      case 'header':
        return el.parentElement && el.parentElement.closest(kLandmarkAncestor) ? null : 'banner';
      case 'hr': return 'separator';
      case 'html': return 'document';
      case 'img':
        return el.getAttribute('alt') === '' && !el.getAttribute('title') && !hasGlobalAria(el) && !hasTabIndex(el)
          ? 'presentation'
          : 'img';
      case 'input': {
        const type = (el.type || 'text').toLowerCase();
        if (type === 'search') return el.hasAttribute('list') ? 'combobox' : 'searchbox';
        if (['email', 'tel', 'text', 'url', ''].includes(type)) return el.hasAttribute('list') ? 'combobox' : 'textbox';
        if (type === 'hidden') return null;
        if (type === 'file') return 'button';
        return kInputRoles[type] || 'textbox';
      }
      case 'ins': return 'insertion';
      case 'li': return 'listitem';
      case 'main': return 'main';
      case 'mark': return 'mark';
      case 'math': return 'math';
      case 'menu': return 'list';
      case 'meter': return 'meter';
      case 'nav': return 'navigation';
      case 'ol': case 'ul': return 'list';
      case 'optgroup': return 'group';
      case 'option': return 'option';
      case 'output': return 'status';
      case 'p': return 'paragraph';
      case 'progress': return 'progressbar';
      case 'search': return 'search';
      case 'section': return hasExplicitName(el) ? 'region' : null;
      case 'select': return el.hasAttribute('multiple') || el.size > 1 ? 'listbox' : 'combobox';
      case 'strong': return 'strong';
      case 'sub': return 'subscript';
      case 'sup': return 'superscript';
      case 'svg': return 'img';
      case 'table': return 'table';
      case 'tbody': case 'tfoot': case 'thead': return 'rowgroup';
      case 'td': return 'cell';
      case 'textarea': return 'textbox';
      case 'th': return 'columnheader';
      case 'time': return 'time';
      case 'tr': return 'row';
    }
    return null;
  };
  const roleOf = (el) => {
    const explicit = (el.getAttribute('role') || '')
      .split(' ')
      .map((role) => role.trim())
      .find((role) => kValidRoles.has(role));
    if (!explicit) return implicitRole(el);
    if ((explicit === 'none' || explicit === 'presentation') && (hasGlobalAria(el) || isFocusable(el))) {
      return implicitRole(el);
    }
    return explicit;
  };
  const hasAriaDisabled = (el, isAncestor) => {
    if (!el) return false;
    if (isAncestor || kAriaDisabledRoles.has(roleOf(el) || '')) {
      const value = (el.getAttribute('aria-disabled') || '').toLowerCase();
      if (value === 'true') return true;
      if (value === 'false') return false;
      return hasAriaDisabled(parentOf(el), true);
    }
    return false;
  };
  const isDisabled = (el) => isNativelyDisabled(el) || hasAriaDisabled(el, false);

  const kNameFromContent = new Set([
    'button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading', 'link', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'row', 'rowheader', 'switch', 'tab',
    'tooltip', 'treeitem',
  ]);
  const kNameFromDescendant = new Set([
    '', 'caption', 'code', 'contentinfo', 'definition', 'deletion', 'emphasis', 'insertion', 'list',
    'listitem', 'mark', 'none', 'paragraph', 'presentation', 'region', 'row', 'rowgroup', 'section',
    'strong', 'subscript', 'superscript', 'table', 'term', 'time',
  ]);
  const byId = (el, id) => {
    const root = el.getRootNode();
    return root && root.getElementById ? root.getElementById(id) : el.ownerDocument.getElementById(id);
  };
  const labelledByElements = (el) =>
    (el.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => byId(el, id))
      .filter(Boolean);
  const valueName = (el, role) => {
    if (role === 'textbox' || role === 'searchbox') {
      return el.nodeName === 'INPUT' || el.nodeName === 'TEXTAREA' ? el.value : el.textContent || '';
    }
    if (role === 'combobox' || role === 'listbox') {
      if (el.nodeName === 'SELECT') return Array.from(el.selectedOptions).map((o) => o.textContent || '').join(' ');
      if (el.nodeName === 'INPUT') return el.value;
      return null;
    }
    if (['progressbar', 'scrollbar', 'slider', 'spinbutton', 'meter'].includes(role)) {
      if (el.hasAttribute('aria-valuetext')) return el.getAttribute('aria-valuetext') || '';
      if (el.hasAttribute('aria-valuenow')) return el.getAttribute('aria-valuenow') || '';
      return el.getAttribute('value') || '';
    }
    return null;
  };
  const nativeName = (el, ctx) => {
    const tag = el.nodeName;
    const type = (el.type || '').toLowerCase();
    if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(type)) {
      const value = el.value || '';
      if (value.trim()) return value;
      if (type === 'submit') return 'Submit';
      if (type === 'reset') return 'Reset';
      return el.getAttribute('title') || '';
    }
    if (tag === 'INPUT' && type === 'image') {
      const alt = el.getAttribute('alt') || '';
      if (alt.trim()) return alt;
      const title = el.getAttribute('title') || '';
      if (title.trim()) return title;
      return 'Submit';
    }
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const labels = el.labels ? Array.from(el.labels) : [];
      const text = labels
        .map((label) => nameOf(label, { visited: ctx.visited, embedded: 'label' }))
        .filter(Boolean)
        .join(' ');
      if (text.trim()) return text;
      const textLike =
        tag === 'TEXTAREA' ||
        (tag === 'INPUT' && !['checkbox', 'radio', 'file', 'hidden', 'range', 'color'].includes(type));
      if (textLike) {
        const title = el.getAttribute('title') || '';
        if (title.trim()) return title;
        const placeholder = el.getAttribute('placeholder') || '';
        if (placeholder.trim()) return placeholder;
      }
      return '';
    }
    const child = (selector) => {
      const found = el.querySelector(selector);
      return found ? nameOf(found, { visited: ctx.visited, embedded: 'label' }) : '';
    };
    if (tag === 'FIELDSET') return child(':scope > legend');
    if (tag === 'FIGURE') return child(':scope > figcaption');
    if (tag === 'TABLE') return child(':scope > caption');
    if (tag === 'IMG' || tag === 'AREA') return el.getAttribute('alt') || '';
    if (el.localName === 'svg') {
      const title = el.querySelector(':scope > title');
      return title ? title.textContent || '' : '';
    }
    return '';
  };
  const contentName = (el, ctx) => {
    const parts = [];
    const pseudo = (which) => {
      try {
        const content = el.ownerDocument.defaultView.getComputedStyle(el, which).content;
        if (content && /^["'].*["']$/.test(content)) return content.slice(1, -1);
      } catch (e) {}
      return '';
    };
    parts.push(pseudo('::before'));
    const children =
      el.nodeName === 'SLOT'
        ? el.assignedNodes()
        : el.shadowRoot
          ? Array.from(el.shadowRoot.childNodes)
          : Array.from(el.childNodes);
    const childCtx = {
      visited: ctx.visited,
      embedded: ctx.embedded === 'label' || ctx.embedded === 'labelledby' ? ctx.embedded : 'descendant',
    };
    for (const child of children) {
      if (child.nodeType === 3) {
        parts.push(child.nodeValue || '');
      } else if (child.nodeType === 1) {
        let token = nameOf(child, childCtx);
        const style = styleOf(child);
        const display = (style && style.display) || 'inline';
        if (display !== 'inline' || child.nodeName === 'BR') token = ' ' + token + ' ';
        parts.push(token);
      }
    }
    parts.push(pseudo('::after'));
    return parts.join('');
  };
  const nameOf = (el, ctx) => {
    if (ctx.visited.has(el)) return '';
    if (ctx.embedded !== 'labelledby' && isHiddenForAria(el)) return '';
    ctx.visited.add(el);
    const role = roleOf(el) || '';
    if (ctx.embedded !== 'labelledby') {
      const refs = labelledByElements(el);
      if (refs.length) {
        return refs.map((ref) => nameOf(ref, { visited: ctx.visited, embedded: 'labelledby' })).join(' ');
      }
    }
    if (ctx.embedded) {
      const value = valueName(el, role);
      if (value !== null) return value;
    }
    const ariaLabel = el.getAttribute('aria-label') || '';
    if (ariaLabel.trim()) return ariaLabel;
    if (role !== 'none' && role !== 'presentation') {
      const native = nativeName(el, ctx);
      if (native.trim()) return native;
    }
    if (
      kNameFromContent.has(role) ||
      ctx.embedded === 'label' ||
      ctx.embedded === 'labelledby' ||
      (ctx.embedded === 'descendant' && kNameFromDescendant.has(role))
    ) {
      const text = contentName(el, ctx);
      if (text.trim()) return text;
    }
    if (!ctx.embedded) {
      const title = el.getAttribute('title') || '';
      if (title.trim()) return title;
    }
    return '';
  };
  const accessibleName = (el) => normalize(nameOf(el, { visited: new Set(), embedded: null }));

  const makeMatcher = (match) => {
    if (match.kind === 'pattern') {
      const re = new RegExp(match.source, match.flags);
      return (value) => {
        re.lastIndex = 0;
        return re.test(value);
      };
    }
    const text = normalize(match.text);
    if (match.exact) return (value) => value === text;
    const lower = text.toLowerCase();
    return (value) => value.toLowerCase().includes(lower);
  };

  const skipForText = (el) =>
    el.nodeName === 'SCRIPT' ||
    el.nodeName === 'NOSCRIPT' ||
    el.nodeName === 'STYLE' ||
    (!!el.ownerDocument && !!el.ownerDocument.head && el.ownerDocument.head.contains(el));
  const textCache = new Map();
  const elementText = (root) => {
    let value = textCache.get(root);
    if (value !== undefined) return value;
    value = '';
    if (root.nodeType === 11 || !skipForText(root)) {
      if (root.nodeName === 'INPUT' && (root.type === 'submit' || root.type === 'button')) {
        value = root.value;
      } else {
        for (let child = root.firstChild; child; child = child.nextSibling) {
          if (child.nodeType === 3) value += child.nodeValue || '';
          else if (child.nodeType === 1) value += elementText(child);
        }
        if (root.shadowRoot) value += elementText(root.shadowRoot);
      }
    }
    value = normalize(value);
    textCache.set(root, value);
    return value;
  };
  const matchesTextSelf = (el, matcher) => {
    if (skipForText(el)) return false;
    if (!matcher(elementText(el))) return false;
    for (let child = el.firstElementChild; child; child = child.nextElementSibling) {
      if (matcher(elementText(child))) return false;
    }
    if (el.shadowRoot && matcher(elementText(el.shadowRoot))) return false;
    return true;
  };
  const labelsOf = (el) => {
    const refs = labelledByElements(el);
    if (refs.length) return refs.map((ref) => elementText(ref));
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel !== null && ariaLabel.trim()) return [normalize(ariaLabel)];
    const labelable =
      ['BUTTON', 'METER', 'OUTPUT', 'PROGRESS', 'SELECT', 'TEXTAREA'].includes(el.nodeName) ||
      (el.nodeName === 'INPUT' && el.type !== 'hidden');
    if (labelable && el.labels) return Array.from(el.labels).map((label) => elementText(label));
    return [];
  };

  const splitSelectorList = (selector) => {
    const parts = [];
    let depth = 0;
    let quote = null;
    let start = 0;
    for (let i = 0; i < selector.length; i++) {
      const c = selector[i];
      if (c === '\\') {
        i++;
        continue;
      }
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === ',' && depth === 0) {
        parts.push(selector.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(selector.slice(start));
    return parts.map((part) => part.trim()).filter(Boolean);
  };
  const queryCss = (root, selector) => {
    if (!selector.includes(':visible')) return queryDeep(root, selector);
    const out = [];
    for (const part of splitSelectorList(selector)) {
      if (part.includes(':visible')) {
        const plain = part.replace(/:visible/g, '') || '*';
        for (const el of queryDeep(root, plain)) if (isVisible(el)) out.push(el);
      } else {
        for (const el of queryDeep(root, part)) out.push(el);
      }
    }
    return out;
  };

  const documentOrder = (a, b) => {
    if (a === b) return 0;
    const position = a.compareDocumentPosition(b);
    if (position & 4) return -1;
    if (position & 2) return 1;
    return 0;
  };
  const uniqueInOrder = (list) => Array.from(new Set(list)).sort(documentOrder);

  const resolve = (stepList) => {
    let current = [document];
    for (const step of stepList) {
      if (step.kind === 'nth') {
        const index = step.index < 0 ? current.length + step.index : step.index;
        current = index >= 0 && index < current.length ? [current[index]] : [];
        continue;
      }
      if (step.kind === 'or') {
        const mine = current.filter((node) => node !== document);
        current = uniqueInOrder(mine.concat(resolve(step.steps)));
        continue;
      }
      const next = [];
      for (const root of current) {
        if (step.kind === 'css') {
          for (const el of queryCss(root, step.selector)) next.push(el);
          continue;
        }
        const candidates = queryDeep(root, '*');
        if (root.nodeType === 1) candidates.unshift(root);
        if (step.kind === 'role') {
          const matcher = step.name ? makeMatcher(step.name) : null;
          for (const el of candidates) {
            if (el === root) continue;
            if (roleOf(el) !== step.role) continue;
            if (isHiddenForAria(el)) continue;
            if (matcher && !matcher(accessibleName(el))) continue;
            next.push(el);
          }
        } else if (step.kind === 'text') {
          const matcher = makeMatcher(step.match);
          for (const el of candidates) if (matchesTextSelf(el, matcher)) next.push(el);
        } else if (step.kind === 'label') {
          const matcher = makeMatcher(step.match);
          for (const el of candidates) {
            if (el === root) continue;
            if (labelsOf(el).some((label) => matcher(label))) next.push(el);
          }
        } else if (step.kind === 'placeholder') {
          const matcher = makeMatcher(step.match);
          for (const el of candidates) {
            if (el === root) continue;
            const placeholder = el.getAttribute('placeholder');
            if (placeholder !== null && matcher(normalize(placeholder))) next.push(el);
          }
        }
      }
      current = uniqueInOrder(next);
    }
    return current.filter((node) => node !== document);
  };

  const preview = (el) => {
    const attrs = Array.from(el.attributes)
      .slice(0, 4)
      .map((attr) => ` ${attr.name}="${attr.value.slice(0, 50)}"`)
      .join('');
    const text = normalize(el.textContent).slice(0, 50);
    return `<${el.localName}${attrs}>${text ? text : ''}</${el.localName}>`;
  };
  const editableProblem = (el) => {
    if (el.nodeName === 'INPUT') {
      const type = (el.type || '').toLowerCase();
      if (['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image', 'hidden', 'range', 'color'].includes(type)) {
        return `Input of type "${type}" cannot be filled`;
      }
      return null;
    }
    if (el.nodeName === 'TEXTAREA' || el.isContentEditable) return null;
    return 'Element is not an <input>, <textarea> or [contenteditable] element';
  };
  const nextFrame = () =>
    new Promise((done) => {
      let finished = false;
      const finish = () => {
        if (!finished) {
          finished = true;
          done();
        }
      };
      requestAnimationFrame(finish);
      setTimeout(finish, 100);
    });

  const elements = resolve(steps);
  const count = elements.length;
  const el = count === 1 ? elements[0] : null;
  if (!el) return { count };

  switch (op.type) {
    case 'count':
      return { count };
    case 'state':
      return { count, visible: isVisible(el) };
    case 'enabled':
      return { count, enabled: !isDisabled(el) };
    case 'attribute':
      return { count, value: el.getAttribute(op.name) };
    case 'innerText':
      if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') return { count, error: 'Node is not an HTMLElement' };
      return { count, value: el.innerText };
    case 'inputValue':
      if (el.nodeName !== 'INPUT' && el.nodeName !== 'TEXTAREA' && el.nodeName !== 'SELECT') {
        return { count, error: 'Node is not an <input>, <textarea> or <select> element' };
      }
      return { count, value: el.value };
    case 'focus':
      el.focus();
      return { count, ok: true };
    case 'dispatch': {
      const view = el.ownerDocument.defaultView;
      const init = { bubbles: true, cancelable: true, composed: true };
      const type = op.eventType;
      let event;
      if (['click', 'dblclick', 'mousedown', 'mouseup', 'mouseover', 'mouseout', 'mousemove', 'mouseenter', 'mouseleave', 'contextmenu', 'auxclick'].includes(type)) {
        event = new view.MouseEvent(type, init);
      } else if (['keydown', 'keyup', 'keypress'].includes(type)) {
        event = new view.KeyboardEvent(type, init);
      } else if (['focus', 'blur', 'focusin', 'focusout'].includes(type)) {
        event = new view.FocusEvent(type, init);
      } else {
        event = new view.Event(type, init);
      }
      el.dispatchEvent(event);
      return { count, ok: true };
    }
    case 'evaluate':
      return { count, value: await userFn(el, op.arg) };
    case 'fill': {
      if (!isVisible(el)) return { count, retry: 'element is not visible' };
      if (isDisabled(el)) return { count, retry: 'element is not enabled' };
      const problem = editableProblem(el);
      if (problem) return { count, error: problem };
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.nodeName) && el.hasAttribute('readonly')) {
        return { count, retry: 'element is not editable' };
      }
      el.focus();
      if (el.nodeName === 'INPUT' || el.nodeName === 'TEXTAREA') {
        try {
          el.select();
        } catch (e) {
          el.setSelectionRange(0, el.value.length);
        }
      } else {
        const range = el.ownerDocument.createRange();
        range.selectNodeContents(el);
        const selection = el.ownerDocument.defaultView.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return { count, ok: true };
    }
    case 'click': {
      if (!el.isConnected) return { count, retry: 'element is not attached to the DOM' };
      if (!isVisible(el)) return { count, retry: 'element is not visible' };
      if (isDisabled(el)) return { count, retry: 'element is not enabled' };
      const before = el.getBoundingClientRect();
      await nextFrame();
      let rect = el.getBoundingClientRect();
      if (before.x !== rect.x || before.y !== rect.y || before.width !== rect.width || before.height !== rect.height) {
        return { count, retry: 'element is not stable' };
      }
      const view = el.ownerDocument.defaultView;
      if (rect.top < 0 || rect.left < 0 || rect.bottom > view.innerHeight || rect.right > view.innerWidth) {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        rect = el.getBoundingClientRect();
      }
      const box = Array.from(el.getClientRects()).find((r) => r.width > 0 && r.height > 0) || rect;
      const left = Math.max(box.left, 0);
      const top = Math.max(box.top, 0);
      const right = Math.min(box.right, view.innerWidth);
      const bottom = Math.min(box.bottom, view.innerHeight);
      if (right <= left || bottom <= top) return { count, retry: 'element is outside of the viewport' };
      const x = (left + right) / 2;
      const y = (top + bottom) / 2;
      let hit = el.ownerDocument.elementFromPoint(x, y);
      while (hit && hit.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === hit) break;
        hit = inner;
      }
      let node = hit;
      while (node && node !== el) node = parentOf(node);
      if (!node) {
        return { count, retry: hit ? `${preview(hit)} intercepts pointer events` : 'element does not receive pointer events' };
      }
      return { count, x, y };
    }
  }
  throw new Error('Unknown locator operation: ' + op.type);
}
