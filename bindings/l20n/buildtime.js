  'use strict';

  var Context = require('./context').Context;
  var io = require('./platform/io');
  var rePlaceables = require('./compiler').rePlaceables;

  var ctx;
  var isBootstrapped = false;
  var isPretranslated = false;


  Object.defineProperty(navigator, 'mozL10n', {
    get: function() {
      isBootstrapped = false;
      ctx = new Context();
      ctx.isBuildtime = true;
      ctx.addEventListener('error', addBuildMessage.bind(null, 'error'));
      ctx.addEventListener('warning', addBuildMessage.bind(null, 'warn'));
      return createPublicAPI(ctx);
    },
    enumerable: true
  });

  function bootstrap(forcedLocale) {
    isBootstrapped = true;

    var head = document.head;
    var iniLinks = head.querySelectorAll('link[type="application/l10n"]' + 
                                         '[href$=".ini"]');
    var jsonLinks = head.querySelectorAll('link[type="application/l10n"]' + 
                                          '[href$=".json"]');

    for (var i = 0; i < jsonLinks.length; i++) {
      var uri = jsonLinks[i].getAttribute('href');
      ctx.resLinks.push(uri);
    }

    ctx.ready(function() {
      // XXX instead of using a flag, we could store the list of 
      // yet-to-localize nodes that we get from the inline context, and 
      // localize them here.
      if (!isPretranslated) {
        translateFragment(ctx);
      }
      isPretranslated = false;
      fireLocalizedEvent(ctx);
    });

    // listen to language change events
    if ('mozSettings' in navigator && navigator.mozSettings) {
      navigator.mozSettings.addObserver('language.current', function(event) {
        ctx.requestLocales(event.settingValue);
      });
    }

    var iniToLoad = iniLinks.length;
    if (iniToLoad === 0) {
      ctx.requestLocales(forcedLocale || navigator.language);
      return;
    }

    var io = require('./platform/io');
    for (i = 0; i < iniLinks.length; i++) {
      var url = iniLinks[i].getAttribute('href');
      io.load(url, iniLoaded.bind(null, url));
    }

    function iniLoaded(url, err, text) {
      if (err) {
        throw err;
      }

      var ini = parseINI(text, url);
      for (var i = 0; i < ini.resources.length; i++) {
        var uri = ini.resources[i].replace('en-US', '{{locale}}');
        ctx.resLinks.push(uri);
      }
      iniToLoad--;
      if (iniToLoad === 0) {
        ctx.requestLocales(forcedLocale || navigator.language);
      }
    }

  }

  var patterns = {
    'section': /^\s*\[(.*)\]\s*$/,
    'import': /^\s*@import\s+url\((.*)\)\s*$/i,
    'entry': /[\r\n]+/
  };

  function parseINI(source, iniPath) {
    var entries = source.split(patterns['entry']);
    var locales = ['en-US'];
    var genericSection = true;
    var uris = [];

    for (var i = 0; i < entries.length; i++) {
      var line = entries[i];
      // we only care about en-US resources
      if (genericSection && patterns['import'].test(line)) {
        var match = patterns['import'].exec(line);
        var uri = relativePath(iniPath, match[1]);
        uris.push(uri);
        continue;
      }

      // but we need the list of all locales in the ini, too
      if (patterns['section'].test(line)) {
        genericSection = false;
        var match = patterns['section'].exec(line);
        locales.push(match[1]);
      }
    }
    return {
      locales: locales,
      resources: uris
    };
  }

  function relativePath(baseUrl, url) {
    if (url[0] == '/') {
      return url;
    }

    var dirs = baseUrl.split('/')
      .slice(0, -1)
      .concat(url.split('/'))
      .filter(function(path) {
        return path !== '.';
      });

    return dirs.join('/');
  }

  function createPublicAPI(ctx) {
    var rtlLocales = ['ar', 'fa', 'he', 'ps', 'ur'];
    return {
      get: function l10n_get(id, data) {
        var value = ctx.get(id, data);
        if (value === null) {
          return '';
        }
        return value;
      },
      localize: localizeNode.bind(null, ctx),
      translate: translateFragment.bind(null, ctx),
      language: {
        get code() {
          return ctx.supportedLocales[0];
        },
        set code(lang) {
          if (!isBootstrapped) {
            // build-time optimization uses this
            bootstrap(lang);
          } else {
            ctx.requestLocales(lang);
          }
        },
        get direction() {
          if (rtlLocales.indexOf(ctx.supportedLocales[0]) >= 0) {
            return 'rtl';
          } else {
            return 'ltr';
          }
        }
      },
      ready: ctx.ready.bind(ctx),
      getDictionary: getDictionary,
      get readyState() {
        return ctx.isReady ? 'complete' : 'loading';
      }
    };
  }

  var buildMessages = {};
  function addBuildMessage(type, e) {
    if (!(type in buildMessages)) {
      buildMessages[type] = [];
    }
    if (e instanceof Context.TranslationError &&
        e.locale === ctx.supportedLocales[0] &&
        buildMessages[type].indexOf(e.entity) === -1) {
      buildMessages[type].push(e.entity);
    }
  }

  function flushBuildMessages(variant) {
    for (var type in buildMessages) {
      if (buildMessages[type].length) {
        console.log('[l10n] [' + ctx.supportedLocales[0] + ']: ' +
            buildMessages[type].length + ' missing ' + variant + ': ' +
            buildMessages[type].join(', '));
        buildMessages[type] = [];
      }
    }
  }


  /* API for webapp-optimize */

  Context.prototype.getEntitySource = function getEntitySource(id) {
    if (!this.isReady) {
      throw new Context.Error('Context not ready');
    }
    var cur = 0;
    var loc;
    var locale;
    while (loc = this.supportedLocales[cur]) {
      locale = this.getLocale(loc);
      if (!locale.isReady) {
        // build without callback, synchronously
        locale.build(null);
      }
      if (locale.ast && locale.ast.hasOwnProperty(id)) {
        return locale.ast[id];
      }
      var e = new Context.TranslationError('Not found', id,
                                           this.supportedLocales, locale);
      this._emitter.emit('warning', e);
      cur++;
    }
    return '';
  }

  // return an array of all {{placeables}} found in a string
  function getPlaceableNames(str) {
    var placeables = [];
    var match;
    while (match = rePlaceables.exec(str)) {
      placeables.push(match[1]);
    }
    return placeables;
  }

  // recursively walk an entity and put all dependencies required for string
  // interpolation in the AST
  function getPlaceables(ast, val) {
    if (typeof val === 'string') {
      var placeables = getPlaceableNames(val);
      for (var i = 0; i < placeables.length; i++) {
        var id = placeables[i];
        ast[id] = ctx.getEntitySource(id);
      }
    } else {
      for (var prop in val) {
        if (!val.hasOwnProperty(prop) || val === '_index') {
          continue;
        }
        getPlaceables(ast, val[prop]);
      }
    }
  }

  function getDictionary(fragment) {
    var ast = {};

    if (!fragment) {
      var sourceLocale = ctx.getLocale('en-US');
      if (!sourceLocale.isReady) {
        sourceLocale.build(null);
      }
      // iterate over all strings in en-US
      for (var id in sourceLocale.ast) {
        ast[id] = ctx.getEntitySource(id);
      }
      return ast;
    }

    var elements = getTranslatableChildren(fragment);

    for (var i = 0; i < elements.length; i++) {
      var attrs = getL10nAttributes(elements[i]);
      var val = ctx.getEntitySource(attrs.id);
      ast[attrs.id] = val;
      getPlaceables(ast, val);
    }
    return ast;
  };


  /* DOM translation functions */

  function getTranslatableChildren(element) {
    return element ? element.querySelectorAll('*[data-l10n-id]') : [];
  }


  function getL10nAttributes(element) {
    if (!element) {
      return {};
    }

    var l10nId = element.getAttribute('data-l10n-id');
    var l10nArgs = element.getAttribute('data-l10n-args');
    var args = {};
    if (l10nArgs) {
      try {
        args = JSON.parse(l10nArgs);
      } catch (e) {
        console.warn('could not parse arguments for ' + l10nId);
      }
    }
    return { id: l10nId, args: args };
  }

  function setTextContent(element, text) {
    // standard case: no element children
    if (!element.firstElementChild) {
      element.textContent = text;
      return;
    }

    // this element has element children: replace the content of the first
    // (non-blank) child textNode and clear other child textNodes
    var found = false;
    var reNotBlank = /\S/;
    for (var child = element.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3 && reNotBlank.test(child.nodeValue)) {
        if (found) {
          child.nodeValue = '';
        } else {
          child.nodeValue = text;
          found = true;
        }
      }
    }
    // if no (non-empty) textNode is found, insert a textNode before the
    // element's first child.
    if (!found) {
      element.insertBefore(document.createTextNode(text), element.firstChild);
    }
  }

  function translateNode(ctx, node) {
    var attrs = getL10nAttributes(node);
    if (!attrs.id) {
      return true;
    }

    var entity = ctx.getEntity(attrs.id, attrs.args);
    if (entity === null) {
      return false;
    }

    if (typeof entity === 'string') {
      setTextContent(node, entity);
      return true;
    }

    if (entity.value) {
      setTextContent(node, entity.value);
    }

    if (entity.attributes) {
      for (var key in entity.attributes) {
        if (entity.attributes.hasOwnProperty(key)) {
          var attr = entity.attributes[key];
          var pos = key.indexOf('.');
          if (pos !== -1) {
            node[key.substr(0, pos)][key.substr(pos + 1)] = attr;
          } else {
            node[key] = attr;
          }
        }
      }
    }
    return true;
  }
  
  // localize an node as soon as ctx is ready
  function localizeNode(ctx, element, id, args) {
    if (!element) {
      return;
    }

    if (!id) {
      element.removeAttribute('data-l10n-id');
      element.removeAttribute('data-l10n-args');
      setTextContent(element, '');
      return;
    }

    // set the data-l10n-[id|args] attributes
    element.setAttribute('data-l10n-id', id);
    if (args && typeof args === 'object') {
      element.setAttribute('data-l10n-args', JSON.stringify(args));
    } else {
      element.removeAttribute('data-l10n-args');
    }

    // if ctx is ready, translate now;
    // if not, the element will be translated along with the document anyway.
    if (ctx.isReady) {
      translateNode(ctx, element);
    }
  }
  
  // translate an array of HTML nodes
  // -- returns an array of nodes that could not be translated
  function translateNodes(ctx, elements) {
    var untranslated = [];
    for (var i = 0, l = elements.length; i < l; i++) {
      if (!translateNode(ctx, elements[i])) {
        untranslated.push(elements[i]);
      }
    }
    return untranslated;
  }

  // translate an HTML subtree
  // -- returns an array of elements that could not be translated
  function translateFragment(ctx, element) {
    element = element || document.documentElement;
    var untranslated = translateNodes(ctx, getTranslatableChildren(element));
    if (!translateNode(ctx, element)) {
      untranslated.push(element);
    }
    return untranslated;
  }

  function fireLocalizedEvent(ctx) {
    var event = document.createEvent('Event');
    event.initEvent('localized', false, false);
    event.language = ctx.supportedLocales[0];
    window.dispatchEvent(event);
  }
