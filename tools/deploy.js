// URL parsing and validation
// RPC to server (endpoint, arguments)
// see if RPC requires password
// prompt for password
// send RPC with or without password as required

var qs = require('querystring');
var path = require('path');
var files = require('./files.js');
var httpHelpers = require('./http-helpers.js');
var warehouse = require('./warehouse.js');
var buildmessage = require('./buildmessage.js');
var config = require('./config.js');
var auth = require('./auth.js');
var utils = require('./utils.js');
var _ = require('underscore');
var inFiber = require('./fiber-helpers.js').inFiber;
var Future = require('fibers/future');

// Make a synchronous RPC to the "classic" MDG deploy API. The deploy
// API has the following contract:
//
// - Parameters are always sent in the query string.
// - A tarball can be sent in the body (when deploying an app).
// - On success, all calls return HTTP 200. Those that return a value
//   either return a JSON payload or a plaintext payload and the
//   Content-Type header is set appropriately.
// - On failure, calls return some non-200 HTTP status code and
//   provide a human-readable error message in the body.
// - URLs are of the form "/[operation]/[site]".
// - Body encodings are always utf8.
// - Meteor Accounts auth is possible using first-party MDG cookies
//   (rather than OAuth).
//
// Options include:
// - method: GET, POST, or DELETE. default GET
// - operation: "info", "logs", "mongo", "deploy"
// - site: site name
// - expectPayload: an array of key names. if present, then we expect
//   the server to return JSON content on success and to return an
//   object with all of these key names.
// - expectMessage: if true, then we expect the server to return text
//   content on success.
// - bodyStream: if provided, a stream to use as the request body
// - any other parameters accepted by the node 'request' module, for example
//   'qs' to set query string parameters
//
// Waits until server responds, then returns an object with the
// following keys:
//
// - statusCode: HTTP status code, or null if the server couldn't be
//   contacted
// - payload: if successful, and the server returned a JSON body, the
//   parsed JSON body
// - message: if successful, and the server returned a text body, the
//   body as a string
// - errorMessage: if unsuccessful, a human-readable error message,
//   derived from either a transport-level exception, the response
//   body, or a generic 'try again later' message, as appropriate

var deployRpc = function (options) {
  var genericError = "Server error (please try again later)";

  options = _.clone(options);
  options.headers = _.clone(options.headers || {});
  if (options.headers.cookie)
    throw new Error("sorry, can't combine cookie headers yet");

  var token = auth.getSessionToken(config.getAccountsDomain());
  if (token)
    options.headers.cookie = 'METEOR_AUTH=' + token;

  // XXX pass meteorReleaseContext
  try {
    var result = httpHelpers.request(_.extend(options, {
      url: config.getDeployUrl() + '/' + options.operation + '/' + options.site,
      method: options.method || 'GET',
      bodyStream: options.bodyStream,
      encoding: 'utf8' // Hack, but good enough for the deploy server..
    }));
  } catch (e) {
    return {
      statusCode: null,
      errorMessage: "Connection error (" + e.message + ")"
    };
  }

  var response = result.response;
  var body = result.body;
  var ret = { statusCode: response.statusCode };

  if (response.statusCode !== 200) {
    ret.errorMessage = body.length > 0 ? body : genericError;
    return ret;
  }

  var contentType = response.headers["content-type"] || '';
  if (contentType === "application/json; charset=utf-8") {
    try {
      ret.payload = JSON.parse(body);
    } catch (e) {
      ret.errorMessage = genericError;
      return ret;
    }
  } else if (contentType === "text/plain; charset=utf-8") {
    ret.message = body;
  }

  var hasAllExpectedKeys = _.all(_.map(
    options.expectPayload || [], function (key) {
      return ret.payload && _.has(ret.payload, key);
    }));

  if ((options.expectPayload && ! _.has(ret, 'payload')) ||
      (options.expectMessage && ! _.has(ret, 'message')) ||
      ! hasAllExpectedKeys) {
    delete ret.payload;
    delete ret.message;

    ret.errorMessage = genericError;
  }

  return ret;
};

// Just like deployRpc, but also presents authentication. It will
// prompt the user for a password, or use a Meteor Accounts
// credential, as necessary.
//
// Additional options (beyond deployRpc):
//
// - preflight: if true, do everything but the actual RPC. The only
//   other necessary option is 'site' and possibly 'acceptNew'. On
//   failure, returns an object with errorMessage (just like
//   deployRpc). On success, returns an object without an errorMessage
//   key and possibly with a 'preflightPassword' key (if password was
//   collected).
// - preflightPassword: if previously called for this app with the
//   'preflight' option and a 'preflightPassword' was returned, you
//   can pass 'preflightPassword' back in on a subsequent call to skip
//   the password prompt.
var authedRpc = function (options) {
  options = _.clone(options);
  var preflight = options.preflight;
  var preflightPassword = options.preflightPassword;
  delete options.preflight;
  delete options.preflightPassword;

  // Fetch auth info
  var infoResult = deployRpc({
    operation: 'info',
    site: options.site,
    expectPayload: []
  });

  if (infoResult.statusCode === 404) {
    // Doesn't exist, therefore not protected.
    return preflight ? { } : deployRpc(options);
  }

  if (infoResult.errorMessage)
    return infoResult;
  var info = infoResult.payload;

  if (! _.has(info, 'protection')) {
    // Not protected.
    //
    // XXX should prompt the user to claim the app (only if deploying?)
    return preflight ? { } : deployRpc(options);
  }

  if (info.protection === "password") {
    // Password protected. Read a password, hash it, and include the
    // hashed password as a query parameter when doing the RPC.
    var password = preflightPassword;
    if (! password) {
      var password = utils.readLine({
        echo: false,
        prompt: "Password: "
      });
      process.stdout.write("\n");

      // Hash the password so we never send plaintext over the
      // wire. Doesn't actually make us more secure, but it means we
      // won't leak a user's password, which they might use on other
      // sites too.
      var crypto = require('crypto');
      var hash = crypto.createHash('sha1');
      hash.update('S3krit Salt!');
      hash.update(password);
      password = hash.digest('hex');

      options = _.clone(options);
      options.qs = _.clone(options.qs || {});
      options.qs.password = password;
    }

    return preflight ? { preflightPassword: password } : deployRpc(options);
  }

  if (info.protection === "account") {
    if (! _.has(info, 'authorized')) {
      // Absence of this implies that we are not an authorized user on
      // this app
      return {
        statusCode: null,
        errorMessage: auth.isLoggedIn() ?
          // XXX better error message (probably need to break out of
          // the 'errorMessage printed with brief prefix' pattern)
          "Not an authorized user on this site" :
          "Not logged in"
      }
    }

    // Sweet, we're an authorized user.
    return preflight ? { } : deployRpc(options);
  }

  return {
    statusCode: null,
    errorMessage: "You need a newer version of Meteor to work with this site"
  }
};

// Take a proposed sitename for deploying to. If it looks
// syntactically good, canonicalize it (this essentially means
// stripping 'http://' or a trailing '/' if present) and return it. If
// not, print an error message to stderr and return null.
var canonicalizeSite = function (site) {
  var url = site;
  if (!url.match(':\/\/'))
    url = 'http://' + url;

  var parsed = require('url').parse(url);

  if (! parsed.hostname) {
    process.stdout.write(
"Please specify a domain to connect to, such as www.example.com or\n" +
"http://www.example.com/\n");
    return false;
  }

  if (parsed.pathname != '/' || parsed.hash || parsed.query) {
    process.stdout.write(
"Sorry, Meteor does not yet support specific path URLs, such as\n" +
"http://www.example.com/blog .  Please specify the root of a domain.\n");
    return false;
  }

  return parsed.hostname;
};

// Run the bundler and deploy the result.
//
// Options:
// - appDir: root directory of app to bundle up
// - site: site to deploy as
// - settings: deploy settings to use, if any (omit to leave unchanged
//   from previous deploy of the app, if any)
// - bundleOptions: additional options to pass to the bundler
var bundleAndDeploy = function (options) {
  var site = canonicalizeSite(options.site);
  if (! site)
    process.exit(1);

  // Check auth up front, rather than after the (potentially lengthy)
  // bundling process.
  var preflight = authedRpc({ site: site, preflight: true });
  if (preflight.errorMessage) {
    process.stderr.write("\nError deploying application: " +
                         preflight.errorMessage + "\n");
    process.exit(1);
  }

  var build_dir = path.join(options.appDir, '.meteor', 'local', 'build_tar');
  var bundle_path = path.join(build_dir, 'bundle');

  process.stdout.write('Deploying to ' + site + '.  Bundling...\n');
  var bundler = require('./bundler.js');
  var bundleResult = bundler.bundle(options.appDir, bundle_path,
                                    options.bundleOptions);
  if (bundleResult.errors) {
    process.stdout.write("\n\nErrors prevented deploying:\n");
    process.stdout.write(bundleResult.errors.formatMessages());
    process.exit(1);
  }

  process.stdout.write('Uploading...\n');

  var result = authedRpc({
    method: 'POST',
    operation: 'deploy',
    site: site,
    qs: options.settings ? { settings: options.settings} : {},
    bodyStream: files.createTarGzStream(path.join(build_dir, 'bundle')),
    expectPayload: ['url'],
    preflightPassword: preflight.preflightPassword
  });

  if (result.errorMessage) {
    process.stderr.write("\nError deploying application: " +
                         result.errorMessage + "\n");
    process.exit(1);
  }

  var deployedAt = require('url').parse(result.payload.url);
  var hostname = deployedAt.hostname;

  process.stdout.write('Now serving at ' + hostname + '\n');
  files.rm_recursive(build_dir);

  if (! hostname.match(/meteor\.com$/)) {
    var dns = require('dns');
    dns.resolve(hostname, 'CNAME', function (err, cnames) {
      if (err || cnames[0] !== 'origin.meteor.com') {
        dns.resolve(hostname, 'A', function (err, addresses) {
          if (err || addresses[0] !== '107.22.210.133') {
            process.stdout.write('-------------\n');
            process.stdout.write("You've deployed to a custom domain.\n");
            process.stdout.write("Please be sure to CNAME your hostname to origin.meteor.com,\n");
            process.stdout.write("or set an A record to 107.22.210.133.\n");
            process.stdout.write('-------------\n');
          }
        });
        }
    });
  }
};

var deleteApp = function (site) {
  site = canonicalizeSite(site);
  if (! site)
    process.exit(1);

  var result = authedRpc({
    method: 'DELETE',
    operation: 'deploy',
    site: site,
  });

  if (result.errorMessage) {
    process.stderr.write("Couldn't delete application: " +
                         result.errorMessage + "\n");
    process.exit(1);
  }

  process.stdout.write("Deleted.\n");
};

var temporaryMongoUrl = function (site) {
  site = canonicalizeSite(site);
  if (! site)
    process.exit(1);

  var result = authedRpc({
    operation: 'mongo',
    site: site,
    expectMessage: true
  });

  if (result.errorMessage) {
    process.stderr.write("Couldn't open Mongo connection: " +
                         result.errorMessage + "\n");
    process.exit(1);
  }

  return result.message;
};

var logs = function (site) {
  site = canonicalizeSite(site);
  if (! site)
    process.exit(1);

  var result = authedRpc({
    operation: 'logs',
    site: site,
    expectMessage: true
  });

  if (result.errorMessage) {
    process.stderr.write("Couldn't get logs: " +
                         result.errorMessage + "\n");
    process.exit(1);
  }

  process.stdout.write(result.message);
};

var listAuthorized = function (site) {
  site = canonicalizeSite(site);
  if (! site)
    process.exit(1);

  var result = deployRpc({
    operation: 'info',
    site: site,
    expectPayload: []
  });
  if (result.errorMessage) {
    process.stderr.write("Couldn't get authorized users list: " +
                         result.errorMessage + "\n");
    process.exit(1);
  }
  var info = result.payload;

  if (! _.has(info, 'protection')) {
    process.stdout.write("<anyone>\n");
    process.exit(0);
  }

  if (info.protection === "password") {
    process.stdout.write("<password>\n");
    process.exit(0);
  }

  if (info.protection === "account") {
    if (! _.has(info, 'authorized')) {
      process.stderr.write("Couldn't get authorized users list: " +
                           "You are not authorized\n");
      process.exit(1);
    }

    process.stdout.write((auth.loggedInUsername() || "<you>") + "\n");
    _.each(info.authorized, function (username) {
      process.stdout.write(username + "\n");
    });
    process.exit(0);
  }
};

// action is "add" or "remove"
var changeAuthorized = function (site, action, username) {
  site = canonicalizeSite(site);
  if (! site)
    process.exit(1);

  var result = authedRpc({
    method: 'POST',
    operation: 'authorized',
    site: site,
    qs: action === "add" ? { add: username } : { remove: username }
  });

  if (result.errorMessage) {
    process.stderr.write("Couldn't change authorized users: " +
                         result.errorMessage + "\n");
    process.exit(1);
  }

  process.stdout.write(site + ": " +
                       (action === "add" ? "added " : "removed ")
                       + username + "\n");
  process.exit(0);
};

var claim = function (site) {
  site = canonicalizeSite(site);
  if (! site)
    process.exit(1);

  // Check to see if it's even a claimable site, so that we can print
  // a more appropriate message than we'd get if we called authedRpc
  // straight away (at a cost of an extra REST call)
  var infoResult = deployRpc({
    operation: 'info',
    site: site
  });

  if (infoResult.statusCode === 404) {
    process.stderr.write(
"There isn't a site deployed at that address. Use 'meteor deploy' if\n" +
"you'd like to deploy your app here.\n");
    process.exit(1);
  }

  if (infoResult.payload && infoResult.payload.protection === "account") {
    if (infoResult.payload.authorized)
      process.stderr.write("That site already belongs to you.\n");
    else
      process.stderr.write("Sorry, that site belongs to someone else.\n");
    process.exit(1);
  }

  if (infoResult && infoResult.payload.protection === "password") {
    process.stdout.write(
"To claim this site and transfer it to your account, enter the\n" +
"site password one last time.\n\n");
  }

  var result = authedRpc({
    method: 'POST',
    operation: 'claim',
    site: site
  });

  if (result.errorMessage) {
    process.stderr.write("Couldn't claim site: " +
                         result.errorMessage + "\n");
    process.exit(1);
  }

  process.stdout.write(
site + ": " + "successfully transferred to your account.\n" +
"\n" +
"Show authorized users with:\n" +
"  meteor authorized " + site + "\n" +
"\n" +
"Add authorized users with:\n" +
"  meteor authorized " + site + " --add <username>\n" +
"\n" +
"Remove authorized users with:\n" +
"  meteor authorized " + site + " --remove <user>\n" +
"\n");
  process.exit(0);
};



var runMongoShell = function (url) {
  var mongo_path = path.join(files.get_dev_bundle(), 'mongodb', 'bin', 'mongo');
  var mongo_url = require('url').parse(url);
  var auth = mongo_url.auth && mongo_url.auth.split(':');
  var ssl = require('querystring').parse(mongo_url.query).ssl === "true";

  var args = [];
  if (ssl) args.push('--ssl');
  if (auth) args.push('-u', auth[0]);
  if (auth) args.push('-p', auth[1]);
  args.push(mongo_url.hostname + ':' + mongo_url.port + mongo_url.pathname);

  var child_process = require('child_process');
  var proc = child_process.spawn(mongo_path,
                                 args,
                                 { stdio: 'inherit' });
};


exports.bundleAndDeploy = bundleAndDeploy;
exports.deleteApp = deleteApp;
exports.temporaryMongoUrl = temporaryMongoUrl;
exports.logs = logs;
exports.listAuthorized = listAuthorized;
exports.changeAuthorized = changeAuthorized;
exports.claim = claim;

exports.runMongoShell = runMongoShell;
