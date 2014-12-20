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


function makeJawBoneOAuth2(httpMethod, httpType, host, path, token, tokenSecret) {
    return 'Bearer ' + token;
}
function makeOAuth1Header(httpMethod, httpType, host, path, token, tokenSecret) {

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

    return oauthString;
}
function makeHttpRequest(httpMethod, httpType, host, path, token, tokenSecret, makeOAuth, actionCallback) {

    if(typeof(actionCallback) === 'undefined')  {actionCallback  = function(err, body){if (err) {console.log('makeHttpRequest: ' + err);}};}

    var authHeader = makeOAuth(httpMethod, httpType, host, path, token, tokenSecret);

    var action = httpType == "https" ? https : http;
    var sendRequest = action.request(
        {   method:   httpMethod,
            hostname: host,
            path:     path,
            headers:  {Authorization: authHeader}
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

function userLogin(httpMethod, httpType, host, path, token, tokenSecret, profile, done, makeOAuth, loginAction) {

    var subscribe =function() {
        if (path) {
            process.nextTick(function() {
                makeHttpRequest(httpMethod, httpType, host, path,token, tokenSecret,  makeOAuth);
            });
        }
    }
    if(typeof(loginAction) === 'undefined')  {loginAction  = function(){};}

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
                loginAction();
                done(null, {id:resp.insertId, display:profile.displayName, token:token, tokenSecret:tokenSecret});
            });
        }
        else
        {
            var updateUserQuery = "UPDATE User SET Token=?, TokenSecret=? WHERE Id=?";
            connection.query(updateUserQuery, [token, tokenSecret, resp[0].Id], function(err, updateDataResp) {
                if (err) done(err);
                loginAction();
                done(null, {id: resp[0].Id, display: resp[0].Name, token:token, tokenSecret:tokenSecret});
            });
        }
    });
}

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
passport.serializeUser(function(user, done) {
    done(null, user);
});
passport.deserializeUser(function(obj, done) {
    done(null, obj);
});
passport.use(new FitbitStrategy(
    config.passport.fitbit,
    function(token, tokenSecret, profile, done) {
        userLogin('POST',
                  'https',
                  'api.fitbit.com',
                  '/1/user/-/activities/apiSubscriptions/' + profile.id + '.json',
                  token, tokenSecret,
                  {provider: profile.provider, id: profile.id, displayName: profile.displayName},
                  done, makeOAuth1Header);
    }
));
passport.use(new JawBoneStratergy(
    config.passport.jawbone,
    function(token, tokenSecret, profile, done) {
        userLogin('POST',
                  'https',
                  'jawbone.com',
                  '/nudge/api/v.1.1/users/@me/pubsub?webhook=http%3A%2F%2Fthorsanvil.com%2Ftagfit2%2Frest%2Fdata%2Fjawbone',
                  token, tokenSecret,
                  {provider: profile.provider, id: profile.xid, displayName: profile.first},
                  done, makeJawBoneOAuth2);
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

app.get('/tagfit2/rest/logout',  function(req, res, next) {
    req.logout();
    res.redirect("/tagfit2/");
});

// Fitbit login callback point
app.get('/tagfit2/rest/oauthcallback/:service', function(req, res, next) {authenticationCallback(req.params.service,  req, res, next);});
app.get('/tagfit2/rest/login/:service',         function(req, res, next) {loginRequest(req.params.service, req, res, next);}, loginRequestError);



app.get('/tagfit2/rest/version', function(req, res) {
    res.json({version: '00.01.000', majorVer: 0, minorVer: 1, build: 0});
});

app.get('/tagfit2/rest/team', function(req, res) {
    var connection  = persistance.getConnect();
    //var queryStr    = 'SELECT * FROM Team ORDER BY Distance';
    var queryStr = 'SELECT T.Id, T.Name, count(*) AS Count, sum(TD.Distance) as Distance '
                 + 'FROM Team T '
                 + 'LEFT JOIN  '
                 +       '(SELECT U.Id, U.TeamId, SUM(Distance) AS Distance '
                 +       'FROM User U, UserInfo UI '
                 +       'WHERE U.Id = UI.UserId '
                 +       'GROUP BY U.Id'
                 +       ') TD '
                 + 'ON T.Id=TD.TeamId '
                 + 'Group by T.Id '
                 + 'ORDER BY Distance';
    connection.query(queryStr, function(err, teams) {
        if (err) {console.log('/tagfit2/rest/team E1: ' + err);res.send(500);return;}
        for(var loop=0;loop < teams.length;loop++) {
            if (!teams[loop].Distance) {
                teams[loop].Distance = 0;
                teams[loop].Count = null;
            }
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

// Fitbit sends update when user syncs device.
app.post('/tagfit2/rest/fitbitupdate',
  function(req, res, next) {

    for(var loop=0;loop < req.body.length; loop++)
    {
        var user = req.body[loop];
        process.nextTick(function() {updateFitBitUser(user);});
    }
    res.status(204).send();
  }
);
app.post('/tagfit2/rest/data/jawbone',
    function(req, res, next) {
        for(var loop=0;loop < req.body.events; loop++) {
            var user = req.body.events[loop];
            process.nextTick(function() {updateJawBoneUser(user);});
        }
        console.log('Got Jawbone Data');
        console.log('Body =>' + JSON.stringify(req.body) + '<=');
        res.send(200);
    }
);

function updateJawBoneUser(user) {
    /*
    {"secret_hash":"f4746dfc9cca1c7ebaa2302172df6098268bfd84ca362734dc991acaea070148","events":[{"action":"updation","timestamp":1418921314,"user_xid":"oxt54JAuKgDWglepig","type":"move","event_
    xid":"D_SdL1zals4d_vIoSgpQoV7QkW"}],"notification_timestamp":1418921314}

    GET https://jawbone.com/nudge/api/v.1.1/moves/{xid}

    {"meta":
     {
        "user_xid": "xt54JAuKgDWglepig",
        "message": "OK",
        "code": 200,
        "time": 1418925916
     },
     "data":
     {
        "time_completed": 1418924040,
        "xid": "L1zals4d_vIoSgpQoV7QkW",
        "title": "1,557 steps today",
        "type": "move",
        "time_created": 1418913300,
        "time_updated": 1418925916,
        "details":
        {
          "active_time": 798,
          "tzs": [[1418913300, "America/Los_Angeles"]],
          "inactive_time": 3900,
          "wo_count": 0,
          "wo_longest": 0,
          "bmr": 524.972646801,
          "bg_calories": 46.0979999602,
          "goals": {"steps": 10000},
          "date": 20141218,
          "snapshot_image": "/nudge/image/e/1418924716/als4d_vIoSgpQoV7QkW/9fSV-wusY4Q.png",
          "bmr_day": 1265.20401813,
          "wo_active_time": 0,
          "sunrise": 1418917920,
          "distance": 1148.0,
          "tz": "America/Los_Angeles",
          "longest_active": 191,
          "longest_idle": 1320,
          "calories": 57.8925001643,
          "km": 1.148,
          "steps": 1557,
          "wo_calories": 0,
          "wo_time": 0,
          "sunset": 1418948280
          "hourly_totals":
          { "2014121809": { "distance": 219.0, "active_time": 155, "calories": 8.79099994898, "inactive_time": 1560, "longest_idle_time": 1320, "steps": 297, "longest_active_time": 77 },
            "2014121808": { "distance": 455.0, "active_time": 329, "calories": 18.2209999263, "inactive_time": 2100, "longest_idle_time": 1140, "steps": 625, "longest_active_time": 191 },
            "2014121807": { "distance": 441.0, "active_time": 293, "calories": 17.7900000811, "inactive_time": 0, "longest_idle_time": 0, "steps": 591, "longest_active_time": 171 },
            "2014121806": { "distance": 33.0, "active_time": 21, "calories": 1.29600000381, "inactive_time": 0, "longest_idle_time": 0, "steps": 44, "longest_active_time": 21 }
          }
        }
      }
    }

    */

    if (user.type != 'move' && user.action != 'updation')
    {
        console.log('JawBone: Not an Update Move Event (Ignoring)');
        return;
    }
    
    var provider    = 'jawbone';
    var owner       = user.user_xid;
    var timeStamp   = new Date(user.timestamp * 1000);
    var date        = timeStamp.getFullYear() + '-' + timeStamp.getMonth() + '-' + timeStamp.getDate();
    console.log('Date: ' + date);
    var connection  = persistance.getConnect();
    var queryStr    = "SELECT Id, Token, TokenSecret, DATE_FORMAT(lastUpdate, '%Y-%m-%d') AS LastUpdate FROM User WHERE Service=? and UserId=?";
    connection.query(queryStr, [provider, owner], function(err, resp) {
        if (err)                {console.log('updateUserInfo: E14: ' + err);return;}
        if (resp.length != 1)   {console.log('updateUserInfo: E15: ' + provider + ' ' + owner);return;}

        // GET https://jawbone.com/nudge/api/v.1.1/moves/{xid}
        var path       = '/nudge/api/v.1.1/moves/' + user.event_xid;
        makeHttpRequest('GET', 'https', 'jawbone.com', path, makeJawBoneOAuth2, function(err, res){
            if (err) {console.log('updateUserInfo: E16: ' + err);return;}
            var response    = JSON.parse(res);
            console.log('Distance: ' + response.data.details.distance);
            updateUserInfoInDB(resp[0].Id, resp[0].LastUpdate, date, response.data.details.distance);
        });
    });
}

function updateFitBitUser(user) {

    // Body: [{"collectionType":"activities","date":"2014-12-15","ownerId":"XXX3KP","ownerType":"user","subscriptionId":"XXX3KP"}]

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

        var path = '/1/user/-/activities/date/'+date+'.json';
        makeHttpRequest('GET', 'https', 'api.fitbit.com', path, resp[0].Token, resp[0].TokenSecret, makeOAuth1Header, function(err, res){
            if (err) {console.log('updateUserInfo: E10: ' + err);return;}
            var activity    = JSON.parse(res);
            console.log(res);
            var distance    = activity.summary.distances;
            for(var loop = 0;loop < distance.length; loop++) {
                if (distance[loop].activity == 'total') {
                    var distanceValue = distance[loop].distance * 1000;
                    updateUserInfoInDB(resp[0].Id, resp[0].LastUpdate, date, distanceValue);
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

