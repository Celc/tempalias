var smtp = require('smtp');
var config = require('config');
var sys = require('sys');
var tempalias = require('tempalias');
var dns = require('dns');

var aliasProvider = tempalias.AliasProvider;

if (!config.smtp.smarthost){
  sys.debug('Smarthost not configured. Cannot start');
  process.exit(1);
}
if (!config.smtp.bannerHostname){
  sys.debug('Banner Hostname not configured. Cannot start');
  process.exit(1);
}

var server = new smtp.Server();
server.port = config.smtp.port;
server.host = config.smtp.listen;
server.hostname = config.smtp.bannerHostname;

server.runServer();
sys.puts('tempalias SMTP daemon running on port ' + config.smtp.port +
  (config.smtp.listen ? ' on interface ' + config.smtp.listen : " on all interfaces") );

server.addListener('connect', function(args){
  var session = args[2];

  session.socket.addListener('error', function(){
    sys.debug('Server Socket Error');
    if (session.client){
      session.client.quit();
      delete(session.client);
    }
    session.socket.end();
    delete(session.socket);
  });
});
if (config.smtp.rbls){
  server.addListener('connect', function(args){
    require('rbl').check(args[0], config.smtp.rbls, function(found){
      if (found){
        try{
            args[2].socket.write("500 RBL check failed\r\n");
        }catch(e){
            sys.debug("Exception while writing to client after closing socket"+e);
        }
        args[2].socket.end();
      }else{
        args[1].emitSuccess();
      }
    });
  });
}
server.addListener('ehlo', function(args){
  args[1].emitSuccess(['SIZE '+config.smtp.maxlength]);
});

server.addListener('end', function(args){
  var session = args[0];
  if (session.client){
    session.client.quit();
    delete(session.client);
  }
});

server.addListener('rcpt_to', function(args){
  var addr = args[0], promise = args[1], session = args[2];

  addr = addr.split('@');
  if (config.smtp.domains.indexOf(addr[1]) == -1){
    promise.emitError(['Relaying denied', false, 553]);
    return;
  }

  // true means: Use up one Invocation
  aliasProvider.findById(addr[0], true, function(alias){
    if (!alias){
      promise.emitError(['User unknown', false, 550]);
      return;
    }
    var target = alias.target;

    var setRecipient = function(addr){
      session.client.rcpt(addr)
        .addCallback(function(){
          promise.emitSuccess(addr);
        }).addErrback(function(e){promise.emitError(['Upstream denied from: '+e.data[0], true, e.status])});
    };

    if (session.client){
      if (session.client.socket.readyState != 'open'){
        promise.emitError(['Upstream connection failed', true]);
        return;
      }
      setRecipient(target);
    }else{
      var client = session.client = new smtp.Client();
      client.debug = false;
      client.connect(25, config.smtp.smarthost)
          .addCallback(function(){
            client.socket.addListener('error', function(){
              sys.debug('socket error in client');
              client.socket.end();
            });
            client.mail(session.fromAddress)
              .addErrback(function(e){promise.emitError(['Upstream denied from: '+e.data[0], true, e.status])})
              .addCallback(function(){
                setRecipient(target);
              });
          }).addErrback(function(e){ promise.emitError(['Failure to connect to upstream server: '+e, true]); });

    }

  });
});

server.addListener('mail_from', function(args){
  var addrLine = args[0].split(/\s+/), promise = args[1], session = args[2];
  var i = 0;

  if (! addrLine[0].match(/^[^@]+@[^@.][^@]+\.[^@.]+$/)){
    promise.emitError(["keep address simpler. Please. We only support user@host.domain", true, 501]);
    return;
  }
  for (i = 1; i < addrLine.length; i++){
    var sz = addrLine[i].match(/^SIZE=(\d+)/i);
    if (!sz){
      promise.emitError(["invalid argument", false, 501]);
      return;
    }
    if (parseInt(sz[1], 10) > config.smtp.maxlength){
      promise.emitError(['message would exceed size limit', false, 552]);
      return;
    }
  }
  promise.emitSuccess(addrLine[0]);
});

server.addListener('data', function(args){
  var promise = args[1], session = args[2];

  if (!session.client || session.client.socket.readyState != 'open'){
    promise.emitError(['Upstream connection failed', true]);
    return;
  }

  session.client.beginData()
    .addCallback(function(){
      session.data_counter = 0;
      promise.emitSuccess();
    }).addErrback(function(e){ promise.emitError(["upstream denied data: " + e.data[0], true, e.status]); });
});

server.addListener('data_available', function(args){
  var data = args[0], promise = args[1], session = args[2];

  if (!session.client || session.client.socket.readyState != 'open'){
    promise.emitError(['Upstream connection failed', true]);
    return;
  }
  session.data_counter += data.length;
  if (session.data_counter > config.smtp.maxlength + 100){
    promise.emitError(['Data size exceeded', true, 552]);
    return;
  }
  if (!session.received_added){
    data = 'Received: from ' + session.socket.remoteAddress + "\n" +
           '        by ' + config.smtp.bannerHostname +
               ' with ' + (session.esmtp ? 'ESMTP' : 'SMTP') + " id;\n" +
           '        ' + new Date().toUTCString() + "\n" + data;
    session.received_added = true;
  }

  session.client.sendData(data)
    .addCallback(function(){
      promise.emitSuccess();
  });
});

server.addListener('data_end', function(args){
  var data = args[0], promise = args[1], session = args[2];

  if (!session.client || session.client.socket.readyState != 'open'){
    promise.emitError(['Upstream connection failed', true]);
    return;
  }
  session.client.endData()
    .addCallback(function(){
      promise.emitSuccess();
    }).addErrback(function(e){ promise.emitError(["upstream denied data: " + e.data[0], true, e.status]); });
});
