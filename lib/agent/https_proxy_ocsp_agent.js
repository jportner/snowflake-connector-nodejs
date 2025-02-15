/*
 * Copyright (c) 2013 Nathan Rajlich <nathan@tootallnate.net>
 */

/**
 * Module dependencies.
 */

var net = require('net');
var tls = require('tls');
var url = require('url');
var extend = require('extend');
var HttpsProxyAgent = require('https-proxy-agent');
var createAgent = require('agent-base');
var inherits = require('util').inherits;
var debug = require('debug')('https-proxy-agent');
var SocketUtil = require('./socket_util');
const Logger = require('../logger');

/**
 * Module exports.
 */

module.exports = HttpsProxyOcspAgent;

/**
 * The `HttpsProxyAgent` implements an HTTP Agent subclass that connects to the
 * specified "HTTP(s) proxy server" in order to proxy HTTPS requests.
 *
 * @api public
 */

function HttpsProxyOcspAgent(opts)
{
  if (!(this instanceof HttpsProxyOcspAgent))
  {
    return new HttpsProxyOcspAgent(opts);
  }
  if ('string' == typeof opts)
  {
    opts = url.parse(opts);
  }
  if (!opts)
  {
    throw new Error('an HTTP(S) proxy server `host` and `port` must be specified!');
  }
  debug('creating new HttpsProxyAgent instance: %o', opts);
  var HttpsAgent = new HttpsProxyAgent(opts);
  var Agent = createAgent.call(this, connect);
  HttpsAgent.callback = Agent.callback;
  HttpsAgent.timeout = Agent.timeout;
  HttpsAgent.options = Agent.opts;

  var proxy = extend({}, opts);

  // if `true`, then connect to the proxy server over TLS. defaults to `false`.
  HttpsAgent.secureProxy = proxy.protocol ? /^https:?$/i.test(proxy.protocol) : false;

  // prefer `hostname` over `host`, and set the `port` if needed
  proxy.host = proxy.hostname || proxy.host;
  proxy.port = +proxy.port || (this.secureProxy ? 443 : 80);

  if (proxy.host && proxy.path)
  {
    // if both a `host` and `path` are specified then it's most likely the
    // result of a `url.parse()` call... we need to remove the `path` portion so
    // that `net.connect()` doesn't attempt to open that as a unix socket file.
    delete proxy.path;
    delete proxy.pathname;
  }

  if (proxy.user && proxy.password)
  {
    // user:password
    proxy.auth = proxy.user + ':' + proxy.password;
    delete proxy.user;
    delete proxy.password;

    if (!HttpsAgent.secureProxy)
    {
      Logger.getInstance().warn("Warning: connecting to an authenticated proxy server through HTTP. To use HTTPS, set 'proxyProtocol' to 'HTTPS'")
    }
  }

  HttpsAgent.proxy = proxy;
  return HttpsAgent;
}

inherits(HttpsProxyAgent, createAgent);

/**
 * Called when the node-core HTTP client library is creating a new HTTP request.
 *
 * @api public
 */

function connect(req, opts, fn)
{
  var proxy = this.proxy;
  var agent = this;
  Logger.getInstance().debug("Using proxy=%s for host %s", proxy.host, opts.host);

  // create a socket connection to the proxy server
  var socket;
  if (this.secureProxy)
  {
    socket = tls.connect(proxy);
  }
  else
  {
    socket = net.connect(proxy);
  }

  // we need to buffer any HTTP traffic that happens with the proxy before we get
  // the CONNECT response, so that if the response is anything other than an "200"
  // response code, then we can re-play the "data" events on the socket once the
  // HTTP parser is hooked up...
  var buffers = [];
  var buffersLength = 0;

  function read()
  {
    var b = socket.read();
    if (b)
    {
      ondata(b);
    }
    else
    {
      socket.once('readable', read);
    }
  }

  function cleanup()
  {
    socket.removeListener('data', ondata);
    socket.removeListener('end', onend);
    socket.removeListener('error', onerror);
    socket.removeListener('close', onclose);
    socket.removeListener('readable', read);
  }

  function onclose(err)
  {
    debug('onclose had error %o', err);
  }

  function onend()
  {
    debug('onend');
  }

  function onerror(err)
  {
    cleanup();
    fn(err);
  }

  function ondata(b)
  {
    buffers.push(b);
    buffersLength += b.length;
    var buffered = Buffer.concat(buffers, buffersLength);
    var str = buffered.toString('ascii');

    if (!~str.indexOf('\r\n\r\n'))
    {
      // keep buffering
      debug('have not received end of HTTP headers yet...');
      if (socket.read)
      {
        read();
      }
      else
      {
        socket.once('data', ondata);
      }
      return;
    }

    var firstLine = str.substring(0, str.indexOf('\r\n'));
    var statusCode = +firstLine.split(' ')[1];
    debug('got proxy server response: %o', firstLine);

    if (200 === statusCode)
    {
      // 200 Connected status code!
      var sock = socket;

      // nullify the buffered data since we won't be needing it
      buffers = buffered = null;

      if (opts.secureEndpoint)
      {
        var host = opts.host;
        // since the proxy is connecting to an SSL server, we have
        // to upgrade this socket connection to an SSL connection
        debug('upgrading proxy-connected socket to TLS connection: %o', opts.host);
        opts.socket = socket;
        opts.servername = opts.host;
        opts.host = null;
        opts.hostname = null;
        opts.port = null;
        sock = tls.connect(opts);
        // pass in proxy agent to apply proxy for ocsp connection
        // ocsp connection won't be secureEndpoint so no worry for recursive
        // ocsp validation
        SocketUtil.secureSocket(sock, host, agent);
      }

      cleanup();
      fn(null, sock);
    }
    else
    {
      // some other status code that's not 200... need to re-play the HTTP header
      // "data" events onto the socket once the HTTP machinery is attached so that
      // the user can parse and handle the error status code
      cleanup();

      // save a reference to the concat'd Buffer for the `onsocket` callback
      buffers = buffered;

      // need to wait for the "socket" event to re-play the "data" events
      req.once('socket', onsocket);
      fn(null, socket);
    }
  }

  function onsocket(socket)
  {
    // replay the "buffers" Buffer onto the `socket`, since at this point
    // the HTTP module machinery has been hooked up for the user
    if ('function' == typeof socket.ondata)
    {
      // node <= v0.11.3, the `ondata` function is set on the socket
      socket.ondata(buffers, 0, buffers.length);
    }
    else if (socket.listeners('data').length > 0)
    {
      // node > v0.11.3, the "data" event is listened for directly
      socket.emit('data', buffers);
    }
    else
    {
      // never?
      throw new Error('should not happen...');
    }

    // nullify the cached Buffer instance
    buffers = null;
  }

  socket.on('error', onerror);
  socket.on('close', onclose);
  socket.on('end', onend);

  if (socket.read)
  {
    read();
  }
  else
  {
    socket.once('data', ondata);
  }

  var hostname = opts.host + ':' + opts.port;
  var msg = 'CONNECT ' + hostname + ' HTTP/1.1\r\n';
  var auth = proxy.auth;
  if (auth)
  {
    msg += 'Proxy-Authorization: Basic ' + Buffer.from(auth, 'utf8').toString('base64') + '\r\n';
  }
  msg += 'Host: ' + hostname + '\r\n' +
    'Connection: close\r\n' +
    '\r\n';
  socket.write(msg);
}
