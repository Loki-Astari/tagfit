var express         = require('express');
var passport        = require('passport');
var FitbitStrategy  = require('passport-fitbit').Strategy;
var JawBoneStratergy= require('passport-jawbone').Strategy;
var persistance     = require('./TagFitDB.js');
var oauthSignature  = require('oauth-signature');
var https           = require('https');
var http            = require('http');
var randomString    = require("randomstring");
var config          = require('../config.js');


passport.serializeUser(function(user, done) {
    done(null, user);
});
passport.deserializeUser(function(obj, done) {
    done(null, obj);
});
function userLogin(token, tokenSecret, profile, done, subscribe) {
    var connection  = persistance.getConnect();
    var queryStr    = "SELECT Id, Name FROM User WHERE Service=? and UserId=?";
    connection.query(queryStr, [profile.provider, profile.id], function(err, resp) {
        if (err) done(err);
        if (resp.length == 0)
        {// Name  Service UserId Token TokenSecret TeamId lastUpdate
            var addUserQuery = "INSERT INTO User (Name, Service, UserId, Token, TokenSecret, TeamId, lastUpdate) VALUES(?, ?, ?, ?, ?, NULL, subdate(now(), 2))";
            connection.query(addUserQuery, [profile.displayName, profile.provider, profile.id, token, tokenSecret], function(err, resp) {
                if (err) done(err);
                subscribe();
                done(null, {id:resp.insertId, display:profile.displayName, token:token, tokenSecret:tokenSecret});
            });
        }
        else
        {
            var updateUserQuery = "UPDATE User SET Token=?, TokenSecret=? WHERE Id=?";
            connection.query(updateUserQuery, [token, tokenSecret, resp[0].Id], function(err, updateDataResp) {
                if (err) done(err);
                done(null, {id: resp[0].Id, display: resp[0].Name, token:token, tokenSecret:tokenSecret});
            });
        }
    });
}
passport.use(new FitbitStrategy(
    config.passport.fitbit,
    function(token, tokenSecret, profile, done) {
        function subscribe() {
            process.nextTick(function() {
                makeHttpRequest('POST', 'https', 'api.fitbit.com', '/1/user/-/activities/apiSubscriptions/' + profile.id + '.json', token, tokenSecret);
            });
        }
        userLogin(token, tokenSecret, {provider: profile.provider, id: profile.id, displayName: profile.displayName}, done, subscribe);
    }
));
passport.use(new JawBoneStratergy(
    config.passport.jawbone,
    function(token, tokenSecret, profile, done) {
        function subscribe() {
            // process.nextTick(function() {subscribeUser(profile.id, token, tokenSecret);});
        }
        userLogin(token, tokenSecret, {provider: profile.provider, id: profile.xid, displayName: profile.first}, done, subsribe);
    }
));

var app     = express();
app.configure(function() {
    app.use(express.cookieParser());
    app.use(express.bodyParser());
    app.use(express.session({secret: 'SECRET1'}));
    app.use(passport.initialize());
    app.use(passport.session());
});



app.get('/tagfit2/rest/version', function(req, res) {
    res.json({version: '00.01.000', majorVer: 0, minorVer: 1, build: 0});
});

app.get('/tagfit2/rest/team', function(req, res) {
    var connection  = persistance.getConnect();
    //var queryStr    = 'SELECT * FROM Team ORDER BY Distance';
    var queryStr = 'SELECT T.Id, T.Name, TD.Distance, TD.Count '
                 + 'FROM Team T '
                 + 'LEFT JOIN '
                 +       '(SELECT U.TeamId, count(*) AS Count, SUM(Distance) AS Distance '
                 +       ' FROM User U, UserInfo UI '
                 +       ' WHERE U.Id = UI.UserId '
                 +       ' GROUP by U.TeamId'
                 +       ') TD '
                 + 'ON   T.Id=TD.TeamId '
                 + 'ORDER BY TD.Distance';
    connection.query(queryStr, function(err, teams) {
        if (err) {console.log('/tagfit2/rest/team E1: ' + err);res.send(500);return;}
        for(var loop=0;loop < teams.length;loop++) {
            if (!teams[loop].Distance) { teams[loop].Distance = 0;}
        }
         res.json({Name: 'Team', items: teams});
    });
});
app.get('/tagfit2/rest/team/:team_id', function(req, res) {
    var connection  = persistance.getConnect();
    var queryStr    = 'SELECT (Year(UI.lastUpdate) + DAYOFYEAR(UI.lastUpdate)) AS Name, sum(UI.Distance) AS Distance '
                    + 'FROM     User U, UserInfo UI '
                    + 'WHERE    U.TeamId=? && UI.UserId=U.Id '
                    + 'GROUP BY UI.lastUpdate '
                    + 'ORDER BY UI.lastUpdate ';
    connection.query(queryStr, req.params.team_id, function(err, teams) {
        if (err) {console.log('/tagfit2/rest/team/:team_id $2: ' + err);res.send(500);return;}
        if (teams.length > 0)
        {
            var start   = teams[0].Name - 1;
            var dist    = 0;
            for(var loop=0;loop < teams.length; loop++) {
                dist    += teams[loop].Distance;
                teams[loop].Name = ('Day: ' + (teams[loop].Name - start));
                teams[loop].Distance = dist;
            }
        }

        res.json({Name: 'Progress', items: teams});
    });
});

app.get('/tagfit2/rest/curentUser', function(req, res) {
    if (req.user) {
        var connection  = persistance.getConnect();
        var queryStr    = "SELECT T.Name FROM User U, Team T WHERE U.Id=? && U.TeamId = T.Id";
        connection.query(queryStr, req.user.id, function(err, data) {
            if (err) {console.log('/tagfit2/rest/curentUser E3: ' + err);res.send(500);return;}
            if (data.length == 0) {
                var teamNames   = "SELECT Id, Name FROM Team";
                connection.query(teamNames, function(err, data) {
                    if (err) {console.log('/tagfit2/rest/curentUser E4: ' + err);res.send(500);return;}
                    res.json({loggedin: true, display: req.user.display, team: false, teams: data});
                });
            }
            else {
                res.json({loggedin: true, display: req.user.display + '(' + data[0].Name + ')', team: true});
            }
        });
    }
    else {
        res.json({loggedin: false});
    }
});
app.get('/tagfit2/rest/join/:team_id', function(req, res) {
    if (req.user) {
        var connection  = persistance.getConnect();
        var queryStr    = "SELECT T.Name FROM User U, Team T WHERE U.Id=? && U.TeamId = T.Id";
        connection.query(queryStr, req.user.id, function(err, userData) {
            if (err) {console.log('/tagfit2/rest/join/:team_id E5: ' + err);res.send(500);return;}
            if (userData.length == 0) {
                var validateStr = "SELECT Name FROM Team where Id=?";
                connection.query(validateStr, req.params.team_id, function(err, teamData) {
                    if (err) {console.log('/tagfit2/rest/join/:team_id E6: ' + err);send(500);return;}
                    if (teamData.length > 0) {
                        var joinStr = "UPDATE User set TeamId=? where Id=?";
                        connection.query(joinStr, [req.params.team_id, req.user.id], function(err, insert) {
                            if (err) {console.log('/tagfit2/rest/join/:team_id E7: ' + err);send(500);return;} 
                            res.json({loggedin: true, display: req.user.display + '(' + teamData[0].Name + ')', team: true});
                        });
                    }
                    else {
                        res.json({loggedin: true, display: req.user.display, team: false});
                    }
                });
            }
            else {
                res.json({loggedin: true, display: req.user.display + '(' + data[0].Name + ')', team: true});
            }
        });
    }
    else {
        res.json({loggedin: false});
    }
});
app.get('/tagfit2/rest/logout',  function(req, res, next) {
    req.logout();
    res.redirect("/tagfit2/");
});
function makeHttpRequest(httpMethod, httpType, host, path, token, tokenSecret, actionCallback) {

    if(typeof(actionCallback) === 'undefined')  {actionCallback = function(err, body){if (err) {console.log('makeHttpRequest: ' + err);}};}

    var consumerSecret  = config.passport.fitbit.consumerSecret;
    var time        = Math.floor(new Date().getTime()/1000);
    var nonce       = randomString.generate(16);
    var parameters  = {
        'oauth_consumer_key':     config.passport.fitbit.consumerKey,
        'oauth_nonce':            nonce,
        'oauth_signature_method': 'HMAC-SHA1',
        'oauth_timestamp':        time,
        'oauth_token':            token,
        'oauth_version':          '1.0'
    };

    encodedSignature = oauthSignature.generate(httpMethod, httpType + '://' + host + path, parameters, consumerSecret, tokenSecret);

    var oauthString   = "OAuth ";
    Object.keys(parameters).forEach(function(key) {
        oauthString   += key + '="' + parameters[key] + '", ';
    });
    oauthString += 'oauth_signature="' + encodedSignature + '"';

    var action = httpType == "https" ? https : http;
    var sendRequest = action.request(
        {   method:   httpMethod,
            hostname: host,
            path:     path,
            headers:  {Authorization: oauthString}
        },
        function(sendResponse) {
            var data    = '';
            sendResponse.setEncoding('utf8');
            sendResponse.on('data', function(chunk) {
                data    += chunk;
            });
            sendResponse.on('end', function() {
                actionCallback(null, data);
            });
        }
    );
    sendRequest.on('error', function(error) {
        actionCallback(httpMethod + ' ' + httpType + '://' + host + path + ' ERROR => ' + error);
    });
    sendRequest.end();
}

function authenticationCallback(type, req, res, next) {
    console.log('authenticationCallback: ' + type);
    passport.authenticate(type,
        function(err, user) {
            if (err)        { console.log('Err: ' + err);return next(err) }
            if (!user)      { console.log('No User');    return next("No User");}

            console.log('About to log in');
            req.login(user,
                function(err) {
                    console.log('Login callback');
                    if (err) { console.log('Login callback error: ' + err);return next(err) };
                    console.log('Redirect to main page');
                    res.redirect('/tagfit2/');
                }
            );
        }
    )(req, res, next);
}
// Fitbit login callback point
app.get('/tagfit2/rest/callback',               function(req, res, next) {authenticationCallback('fitbit',  req, res, next);});
app.get('/tagfit3/rest/oauthcallback/jawbone',  function(req, res, next) {authenticationCallback('jawbone', req, res, next);});

function loginRequest(type, req, res, next) {
    console.log('loginRequest: ' + type);
    passport.authenticate(type,
        function(err, user, info) {
            console.log('loginRequest passport callback');
            if (err)   { console.log('loginRequest passport callback error: ' + err);return res.send({'status':'err','message':err.message}); }
            if (!user) { console.log('loginRequest passport callback no user');return res.send({'status':'fail','message':info.message}); }
            console.log('About to logIn');
            req.logIn(user,
                function(err) {
                    console.log('logIn callback');
                    if (err) { console.log('logIn callback error: ' + err);return res.send({'status':'err','message':err.message}); }
                    return res.send({'status':'ok'});
                }
            );
        }
    )(req, res, next);
}
function loginRequestError(err, req, res, next) {
    return res.send({'status':'err','message':err.message});
}
// Fitbit login request.
app.get('/tagfit2/rest/fitbit',
    function(req, res, next) {loginRequest('fitbit', req, res, next);},
    loginRequestError
);
// Fitbit login request.
app.get('/tagfit3/rest/jawbone',
    function(req, res, next) {loginRequest('jawbone', req, res, next);},
    loginRequestError
);
// Fitbit sends update when user syncs device.
app.post('/tagfit2/rest/fitbitupdate',
  function(req, res, next) {

    for(var loop=0;loop < req.body.length; loop++)
    {
        var user = req.body[loop];
        process.nextTick(function() {updateUserInfo(user);});
    }
    res.status(204).send();
  }
);

function updateUserInfo(user) {

    // Body: [{"collectionType":"activities","date":"2014-12-15","ownerId":"2WQ3KP","ownerType":"user","subscriptionId":"2WQ3KP"}]

    // GET /1/user/-/activities/date/2010-02-21.json

    /* Body: {  "activities":[],
                "goals":{"activeMinutes":30,"caloriesOut":2184,"distance":8.05,"steps":10000},
                "summary":{
                    "activeScore":-1,
                    "activityCalories":405,
                    "caloriesBMR":1534,
                    "caloriesOut":1869,
                    "distances":[
                        {"activity":"total","distance":1.78},
                        {"activity":"tracker","distance":1.78},
                        {"activity":"loggedActivities","distance":0},
                        {"activity":"veryActive","distance":0},
                        {"activity":"moderatelyActive","distance":1.23},
                        {"activity":"lightlyActive","distance":0.54},
                        {"activity":"sedentaryActive","distance":0}
                    ],
                    "fairlyActiveMinutes":34,
                    "lightlyActiveMinutes":46,
                    "marginalCalories":211,
                    "sedentaryMinutes":875,
                    "steps":2256,
                    "veryActiveMinutes":0}
                }
    */

    var provider    = 'fitbit';
    var owner       = user.ownerId;
    var date        = user.date;
    var connection  = persistance.getConnect();
    var queryStr    = "SELECT Id, Token, TokenSecret, DATE_FORMAT(lastUpdate, '%Y-%m-%d') AS LastUpdate FROM User WHERE Service=? and UserId=?";
    connection.query(queryStr, [provider, owner], function(err, resp) {
        if (err)                {console.log('updateUserInfo: E8: ' + err);return;}
        if (resp.length != 1)   {console.log('updateUserInfo: E9: ' + provider + ' ' + owner);return;}

        makeHttpRequest('GET', 'https', 'api.fitbit.com', '/1/user/-/activities/date/'+date+'.json', resp[0].Token, resp[0].TokenSecret, function(err, res){
            if (err) {console.log('updateUserInfo: E10: ' + err);return;}
            var activity    = JSON.parse(res);
            var distance    = activity.summary.distances;
            for(var loop = 0;loop < distance.length; loop++) {
                if (distance[loop].activity == 'total') {
                    var distanceValue = distance[loop].distance * 1000;
                    updateUserInfoInDB(resp[loop].Id, resp[loop].LastUpdate, date, distanceValue);
                    break;
                }
            }
        });
    });
}

function updateUserInfoInDB(userId, lastUpdate, thisUpdate, distance) {

    var connection  = persistance.getConnect();
    if (lastUpdate != thisUpdate) {
        var insertStr   = "INSERT INTO UserInfo (UserId, lastUpdate, Distance) VALUES(?, ?, ?)";
        connection.query(insertStr, [userId, thisUpdate, distance], function(err, rep) {
            if (err) {console.log('updateUserInfoInDB: E11: ' + err);return;}
            var updateStr   = "UPDATE User Set lastUpdate=? where Id=?";
            connection.query(updateStr,[thisUpdate, userId], function(err, rep) {
                if (err) {console.log('updateUserInfoInDB: E12: ' + err);return;}
                console.log('User: ' + userId + ' NewData: ' + distance + ' For: ' + thisUpdate);
            });
        });
    }
    else {
        var updateStr   = "UPDATE UserInfo SET Distance=? WHERE UserId=? AND lastUpdate=?";
        connection.query(updateStr, [distance, userId, lastUpdate], function(err, rep) {
            if (err) {console.log('updateUserInfoInDB: E13: ' + err);return}
            console.log('User: ' + userId + ' Update: ' + distance + ' For: ' + thisUpdate);
        });
    }
}


app.listen(config.port);
console.log('Listening on port: ' + config.port);

