dbInfo = {
        host:       'localhost',
        user:       'tagfit2',
        password:   'tagfit2Password',
        database:   'TagFit2'
};

var mysql   = require('mysql');

function setUpConnection(holder, index) {
    holder.db[index] = mysql.createConnection(dbInfo);

    holder.db[index].connect(function(err) {
        if (err) {
            console.log('error when connecting to db:', err);
            setTimeout(function() {setUpConnection(holder, index); }, 2000);
        }
    });

    holder.db[index].on('error', function(err) {
        console.log('db error', err);
        if (err.code === 'PROTOCOL_CONNECTION_LOST') {
            setUpConnection(holder, index);
        } else {
            throw err;
        }
    });
}

module.exports = {

    db:     [null],

    getConnect: function() {
        return this.db[0];
    }
};

setUpConnection(module.exports, 0);
