/*
 * Copyright 2017-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

const
    crypto = require('crypto'),
    express = require('express'),
    bodyParser = require('body-parser'),
    pg = require('pg'),
    request = require('request');

const
    VERIFY_TOKEN = process.env.VERIFY_TOKEN,
    ACCESS_TOKEN = process.env.ACCESS_TOKEN,
    APP_SECRET = process.env.APP_SECRET,
    DATABASE_URL = process.env.DATABASE_URL;

if (!(APP_SECRET && VERIFY_TOKEN && ACCESS_TOKEN && DATABASE_URL)) {
    console.error('Missing environment values.');
    process.exit(1);
}

pg.defaults.ssl = false;

var graphapi = request.defaults({
    baseUrl: 'https://graph.facebook.com',
    json: true,
    auth: {
        'bearer' : ACCESS_TOKEN
    }
});

function verifyRequestSignature(req, res, buf) {
    var signature = req.headers['x-hub-signature'];

    if (!signature) {
		// For testing, let's log an error. In production, you should throw an error.
        console.error('Couldn\'t validate the signature.');
    } else {
        var elements = signature.split('=');
        var signatureHash = elements[1];

        var expectedHash = crypto.createHmac('sha1', APP_SECRET)
			.update(buf)
			.digest('hex');

        if (signatureHash != expectedHash) {
            throw new Error('Couldn\'t validate the request signature.');
        }
    }
}

var app = express();
app.set('port', (process.env.PORT || 5000));
app.use(express.static(__dirname + '/public'));
app.use(bodyParser.json({ verify: verifyRequestSignature }));
app.set('views', __dirname + '/views');
app.set('view engine', 'ejs');

// List out all the kudos recorded in the database
app.get('/', function (request, response) {
    pg.connect(DATABASE_URL, function(err, client, done) {
        if(err) {
            console.error(err);
            return;
        }
        client.query('SELECT DISTINCT * FROM kudos', function(err, result) {
            done();
            if (err) {
                console.error(err); response.send('Error ' + err);
            } else {
                response.render('pages/kudos', {results: result.rows} );
            }
        });
    });
});

// Handle the webhook subscription request from Facebook
app.get('/webhook', function(request, response) {
    if (request.query['hub.mode'] === 'subscribe' &&
		request.query['hub.verify_token'] === VERIFY_TOKEN) {
        console.log('Validated webhook');
        response.status(200).send(request.query['hub.challenge']);
    } else {
        console.error('Failed validation. Make sure the validation tokens match.');
        response.sendStatus(403);
    } 
});

// Handle webhook payloads from Facebook
app.post('/webhook', function(request, response) {
    if(request.body && request.body.entry) {
        request.body.entry.forEach(function(entry) {
            entry.changes.forEach(function(change) {
                if(change.field === 'mention') {
                    let mention_id = (change.value.item === 'comment') ?
                        change.value.comment_id : change.value.post_id;

                    let message = change.value.message,
                        message_tags = change.value.message_tags,
                        sender = change.value.sender_id,
                        permalink_url = change.value.permalink_url,
                        recipients = [],
                        query_inserts = [];

                    if (!permalink_url) {
                        permalink_url = 'https://work.facebook.com/groups/'
                            + change.value.post_id.split('_')[0]
                            + '/permalink/'
                            + change.value.post_id.split('_')[1];

                        if (change.value.comment_id) {
                            permalink_url += '/?comment_id='
                                + change.value.comment_id.split('_')[1];
                        }
                    }

                    message_tags.forEach(function(message_tag) {
                        // Ignore page / group mentions
                        if(message_tag.type !== 'user') return;
                        // Add the recipient to a list, for later retrieving their manager
                        recipients.push(message_tag.id);
                    });
                    // Add a data row for the insert query
                    recipients.forEach(function(recipient) {
                        query_inserts.push(`(now(),'${permalink_url}','${recipient}','${sender}','${message}')`);
                    });
                    var interval = '1 month';
                    let query = 'INSERT INTO kudos VALUES '
                        + query_inserts.join(',')
                        + `; SELECT DISTINCT * FROM kudos WHERE create_date > now() - INTERVAL '${interval}';`;
                    pg.connect(DATABASE_URL, function(err, client, done) {
                        client.query(query, function(err, result) {
                            done();
                            if (err) {
                                console.error(err);
                            } else if (result) {
                                var summary = 'Kudos received!\n';
                                // iterate through result rows, count number of kudos sent
                                var sender_kudos_sent = 0;
                                result.rows.forEach(function(row) {
                                    if(row.sender == sender) sender_kudos_sent++;
                                });
                                summary += `@[${sender}] has sent ${sender_kudos_sent} kudos in the last ${interval}\n`;

                                // Iterate through recipients, count number of kudos received
                                recipients.forEach(function(recipient) {
                                    let recipient_kudos_received = 0;
                                    result.rows.forEach(function(row) {
                                        if(row.recipient == recipient) recipient_kudos_received++;
                                    });
                                    summary += `@[${recipient}] has received ${recipient_kudos_received} kudos in the last ${interval}.\n`;
                                });
                                // Comment reply with kudos stat summary
                                graphapi({
                                    url: '/' + mention_id + '/comments',
                                    method: 'POST',
                                    qs: {
                                        message: summary
                                    }
                                }, function(error,res,body) {
                                    console.log('Comment reply', mention_id);
                                });
                            }
                            response.sendStatus(200);
                        });
                    });
                }
            });
        });
    }
});

app.listen(app.get('port'), function() {
    console.log('Node app is running on port', app.get('port'));
});
