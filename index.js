var Express = require('express');
var Handlebars = require('handlebars');
var Evernote = require('evernote').Evernote;
var bodyParser = require('body-parser');
var fs = require('fs');
var wifi = require('./wifi.js');
var wait = require('./wait.js');
var evernoteConfig = require('./evernoteConfig.json');

// Start running the server, then, if we don't have a wifi connection after
// 15 seconds, start a private access point that the user can connect to.
startServer();

wait(15000)
  .then(() => wifi.getStatus())
  .then(status => {
    // If we don't have a wifi connection, broadcast our own wifi network.
    // If we don't do that, no one will be able to connect to the server!
    console.log('wifi status:', status);
    if (status !== 'COMPLETED') {
      wifi.startAP();
      console.log('Started private wifi network VaaniSetup');
    }
  });

function startServer(wifiStatus) {
  // Now start up the express server
  var server = Express();

  // When we get POSTs, handle the body like this
  server.use(bodyParser.urlencoded({extended:false}));

  // Define the handler methods for the various URLs we handle
  server.get('/', handleRoot);
  server.get('/wifiSetup', handleWifiSetup);
  server.post('/connecting', handleConnecting);
  server.get('/oauthSetup', handleOauthSetup);
  server.get('/oauth', handleOauth);
  server.get('/oauth_callback', handleOauthCallback);
  server.get('/status', handleStatus);

  // And start listening for connections
  // XXX: note that we are HTTP only... is this a security issue?
  server.listen(80);
  console.log('HTTP server listening on port 80');
}

function getTemplate(filename) {
  return Handlebars.compile(fs.readFileSync(filename, 'utf8'));
}

var wifiSetupTemplate = getTemplate('./templates/wifiSetup.hbs');
var oauthSetupTemplate = getTemplate('./templates/oauthSetup.hbs');
var connectingTemplate = getTemplate('./templates/connecting.hbs');
var statusTemplate = getTemplate('./templates/status.hbs');

// When the client issues a GET request for the list of wifi networks
// scan and return them

// This function handles requests for the root URL '/'.
// We display a different page depending on what stage of setup we're at
function handleRoot(request, response) {
  wifi.getStatus().then(status => {
    console.log("wifi status", status);

    // If we don't have a wifi connection yet, display the wifi setup page
    if (status !== 'COMPLETED') {
      console.log("redirecting to wifiSetup");
      response.redirect('/wifiSetup');
    }
    else {
      // Otherwise, look to see if we have an oauth token yet
      var oauthToken
      try {
        oauthToken = JSON.parse(fs.readFileSync('oauthToken.json', 'utf8'));
      }
      catch(e) {
        oauthToken = null;
      }

      console.log(oauthToken);
      if (!oauthToken || !oauthToken.oauthAccessToken) {
        console.log("oauth setup");
        // if we don't, display the oauth setup page
        response.redirect('/oauthSetup');
      }
      else {
        console.log("good to go");
        // If we get here, then both wifi and oauth are set up, so
        // just display our current status
        response.redirect('/status');
      }
    }
  });
}

function handleWifiSetup(request, response) {
  wifi.scan().then(results => {
     response.send(wifiSetupTemplate({ networks: results }));
  });
}

function handleConnecting(request, response) {
  var ssid = request.body.ssid.trim();
  var password = request.body.password.trim();
  response.send(connectingTemplate({ssid: ssid}));

  // Wait before switching networks to make sure the response gets through.
  // And also wait to be sure that the access point is fully down before
  // defining the new network.
  wait(2000)
    .then(() => wifi.stopAP())
    .then(() => wait(2000))
    .then(() => wifi.defineNetwork(ssid, password));

  // XXX: it would be cool to monitor the network connection and
  // beep (or blink leds) when the network has switched over and the
  // user can click the continue button.
  // Whether or not I should do that, I should at least modify the
  // template so it has a JS-based countdown that makes the user wait
  // 20 seconds or something before enabling the continue button.
}

function handleOauthSetup(request, response) {
  response.send(oauthSetupTemplate());
}

// We hold our oauth state here. If this was a server that ever had
// multiple clients, we'd have to use session state. But since we expect
// only one client, we just use globak state
var oauthState = {};

function handleOauth(request, response) {
  var client = new Evernote.Client(evernoteConfig);
  var callbackURL = request.protocol + "://" + request.headers.host +
      '/oauth_callback';
  console.log(callbackURL);
  client.getRequestToken(callbackURL, gotRequestToken);

  function gotRequestToken(error, oauthToken, oauthTokenSecret, results) {
    if (error) {
      console.error('Error getting request token: ', error);
      oauthState.error = JSON.stringify(error);
      response.redirect('/');
      return;
    }

    // Remember the results of this first step
    oauthState.oauthToken = oauthToken;
    oauthState.oauthTokenSecret = oauthTokenSecret;
    console.log("Got oauth request token", oauthState);

    // And now redirect to Evernote to let the user authorize
    response.redirect(client.getAuthorizeUrl(oauthToken));
  }
}

function handleOauthCallback(request, response) {
  var client = new Evernote.Client(evernoteConfig);
  client.getAccessToken(oauthState.oauthToken,
                        oauthState.oauthTokenSecret,
                        request.query['oauth_verifier'],
                        gotAccessToken);

  function gotAccessToken(error, oauthAccessToken,
                          oauthAccessTokenSecret, results) {
    if (error) {
      if (error.statusCode === 401) {
        console.error('Unauthorized');
      }
      else {
        console.error('Error getting access token:', error);
      }
      require('fs').writeFileSync('oauthToken.json', '{}');
      response.redirect('/');
      return;
    }

    var token = JSON.stringify({
      oauthAccessToken: oauthAccessToken,
      oauthAccessTokenSecret: oauthAccessTokenSecret,
      results: results
    });

    console.log("got oauth access token:", token);
    require('fs').writeFileSync('oauthToken.json', token);
    response.redirect('/');
  }
}

function handleStatus(request, response) {
  // XXX
  // I want to expand the status template so that it actually displays
  // the current wifi and oauth status and displays buttons that take
  // the user back to the /wifiSetup and /oauthSetup pages. In order to
  // do that, this function will need to determine the current network
  // and oauth status (e.g. the expiration date of the token) and pass
  // those to the template.
  response.send(statusTemplate())
}
