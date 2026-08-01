// POS Print Agent — standalone Windows app
// Compile: pkg bin/pos-print-agent-src.js --target node18-win-x64 --output public/downloads/pos-print-agent.exe
//
// Usage:
//   pos-print-agent.exe --install --url=https://yourapp.railway.app --token=YOUR_TOKEN
//   pos-print-agent.exe --uninstall
//   pos-print-agent.exe          (normal run, reads config.json)

var fs   = require('fs');
var path = require('path');
var http  = require('http');
var https = require('https');
var url   = require('url');
var net   = require('net');
var os    = require('os');
var cp    = require('child_process');

var APP_DIR     = path.join(process.env.APPDATA || os.homedir(), 'POSPrintAgent');
var CONFIG_FILE = path.join(APP_DIR, 'config.json');
var EXE_DEST    = path.join(APP_DIR, 'pos-print-agent.exe');
var VBS_FILE    = path.join(APP_DIR, 'run-agent.vbs');
var TASK_NAME   = 'POS Print Agent';
var PORT        = 9191;

// ── Parse CLI args ────────────────────────────────────────────────────────────
var cliArgs = {};
process.argv.slice(2).forEach(function(a) {
  var m = a.match(/^--([^=]+)(?:=(.+))?$/);
  if (m) cliArgs[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : true;
});

if      (cliArgs.install)   doInstall();
else if (cliArgs.uninstall) doUninstall();
else                         doRun();

// ─────────────────────────────────────────────────────────────────────────────
function doInstall() {
  var relayUrl   = cliArgs.url   || '';
  var agentToken = cliArgs.token || '';
  if (!relayUrl || !agentToken) {
    console.error('Usage: pos-print-agent.exe --install --url=https://... --token=...');
    process.exit(1);
  }

  // 1. Create app dir
  if (!fs.existsSync(APP_DIR)) fs.mkdirSync(APP_DIR, { recursive: true });

  // 2. Save config
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ relay_url: relayUrl, agent_token: agentToken }, null, 2), 'utf8');

  // 3. Copy exe to AppData (only when compiled with pkg)
  var exePath = process.pkg ? EXE_DEST : process.execPath;
  if (process.pkg) {
    try { fs.copyFileSync(process.execPath, EXE_DEST); } catch(e) {
      // might fail if already running from that path — that's fine
    }
  }

  // 4. Create VBS launcher (runs exe with hidden window, no terminal)
  var vbs = 'CreateObject("WScript.Shell").Run Chr(34) & "' +
            exePath.replace(/\\/g, '\\\\') +
            '" & Chr(34), 0, False\r\n';
  fs.writeFileSync(VBS_FILE, vbs, 'utf8');

  // 5. Remove old task silently, then create new one
  try { cp.execSync('schtasks /Delete /TN "' + TASK_NAME + '" /F', { stdio: 'ignore' }); } catch(_) {}

  var tmpBat = path.join(APP_DIR, '_reg_task.bat');
  var batContent = [
    '@echo off',
    'schtasks /Create /TN "' + TASK_NAME + '"' +
      ' /TR "wscript.exe /B \\\"' + VBS_FILE + '\\\""' +
      ' /SC ONLOGON /RL HIGHEST /F',
  ].join('\r\n') + '\r\n';
  fs.writeFileSync(tmpBat, batContent, 'utf8');
  try {
    cp.execSync('"' + tmpBat + '"', { stdio: 'pipe' });
  } catch(e) {
    console.error('\nFailed to register startup task. Try running as Administrator.');
    console.error('The agent will still run now but wont auto-start after reboot.');
  }
  try { fs.unlinkSync(tmpBat); } catch(_) {}

  // 6. Start agent now (hidden, detached)
  cp.spawn('wscript.exe', ['/B', VBS_FILE], { detached: true, stdio: 'ignore', windowsHide: true }).unref();

  console.log('');
  console.log('  POS Print Agent installed!');
  console.log('  Running silently in background on port ' + PORT);
  console.log('  Auto-starts when Windows starts.');
  console.log('');
  console.log('  To uninstall: pos-print-agent.exe --uninstall');
  console.log('');
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
function doUninstall() {
  try { cp.execSync('schtasks /Delete /TN "' + TASK_NAME + '" /F', { stdio: 'ignore' }); } catch(_) {}
  // Kill any running instance on port 9191
  try { cp.execSync('for /f "tokens=5" %a in (\'netstat -aon ^| find "9191" ^| find "LISTENING"\') do taskkill /PID %a /F', { shell: true, stdio: 'ignore' }); } catch(_) {}
  console.log('POS Print Agent uninstalled.');
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
function doRun() {
  // Load config: command line > config.json
  var RELAY_URL   = cliArgs.url   || '';
  var AGENT_TOKEN = cliArgs.token || '';
  if (!RELAY_URL && fs.existsSync(CONFIG_FILE)) {
    try {
      var cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      RELAY_URL   = cfg.relay_url   || '';
      AGENT_TOKEN = cfg.agent_token || '';
    } catch(_) {}
  }

  // ── ESC/POS builder ──────────────────────────────────────────────────────
  function printTCP(ip, port, buf) {
    return new Promise(function(resolve, reject) {
      var sock = new net.Socket();
      sock.setTimeout(5000);
      sock.connect(port, ip, function() {
        sock.write(buf, function() {
          setTimeout(function() { sock.destroy(); resolve(); }, 400);
        });
      });
      sock.on('error', function(e) { sock.destroy(); reject(e); });
      sock.on('timeout', function() { sock.destroy(); reject(new Error('Printer timeout')); });
    });
  }

  function buildEscPos(data) {
    var buf = [];
    function txt(s) { var b=Buffer.from(String(s||''),'utf8'); for(var i=0;i<b.length;i++) buf.push(b[i]); }
    function cmd() { for (var i=0;i<arguments.length;i++) buf.push(arguments[i]); }
    function txtnl(s) { txt(s); cmd(0x0A); }
    var pw = (data.paper_width_mm || 80) >= 80 ? 48 : 32;
    function sep(c) { var s=''; for(var j=0;j<pw;j++) s+=c; return s; }
    function rpad(s,n) { s=String(s||''); while(s.length<n) s+=' '; return s.slice(0,n); }
    function lpad(s,n) { s=String(s||''); while(s.length<n) s=' '+s; return s.slice(-n); }
    function ln2(a,b) { return rpad(String(a), pw-String(b).length)+String(b); }
    cmd(0x1B,0x40);
    cmd(0x1C,0x26);
    if (data.type === 'bill') {
      var CUR = data.currency || '$';
      function fmtAmt(n) { n=parseFloat(n)||0; return CUR+(n===Math.round(n)?Math.round(n).toString():n.toFixed(2)); }
      var NW=pw>=48?22:14, QW=pw>=48?4:3, PRW=pw>=48?10:7, TW=pw>=48?12:8;
      function row4(a,b,c,d) { return rpad(a,NW)+lpad(b,QW)+lpad(c,PRW)+lpad(d,TW); }
      var lbls = data.labels || {};
      cmd(0x1B,0x61,0x01); cmd(0x1B,0x21,0x10);
      txtnl(data.shop||'');
      cmd(0x1B,0x21,0x00);
      if (data.header) txtnl(data.header);
      cmd(0x1B,0x61,0x00);
      txtnl(sep('-'));
      txtnl((data.order_type||'Dine-in')+'  Bill #'+(data.bill_id||''));
      txtnl(rpad(data.table||'', pw-22)+(data.date||''));
      if (data.note) { txtnl(sep('-')); txtnl('Note: '+data.note); }
      txtnl(sep('='));
      cmd(0x1B,0x45,0x01);
      txtnl(row4(lbls.item||'Item', lbls.qty||'Qty', lbls.price||'Price', lbls.total_col||'Total'));
      cmd(0x1B,0x45,0x00);
      txtnl(sep('-'));
      var items = data.items || [];
      for (var ii=0; ii<items.length; ii++) {
        var it=items[ii];
        var upr=fmtAmt(parseFloat(it.price)||0);
        var tot=fmtAmt((parseFloat(it.price)||0)*(parseInt(it.qty)||1));
        var nm=String(it.name||'');
        if (nm.length>NW) {
          txtnl(row4(nm.slice(0,NW),'x'+it.qty,upr,tot));
          var r=nm.slice(NW); while(r.length){txtnl(rpad(' '+r.slice(0,NW-1),NW));r=r.slice(NW-1);}
        } else {
          txtnl(row4(nm,'x'+it.qty,upr,tot));
        }
        if (it.note) txtnl(' >> '+it.note);
      }
      txtnl(sep('='));
      if (data.subtotal) txtnl(ln2(lbls.subtotal||'Sub Total', fmtAmt(data.subtotal)));
      if (data.svcfee)   txtnl(ln2((lbls.svcfee||'Service')+' +', fmtAmt(data.svcfee)));
      if (data.discount) txtnl(ln2((lbls.discount||'Discount')+' -', fmtAmt(data.discount)));
      cmd(0x1B,0x45,0x01);
      txtnl(ln2(lbls.total||'Net Total', fmtAmt(data.total)));
      cmd(0x1B,0x45,0x00);
      if (data.iqd_total) txtnl(ln2('IQD', String(data.iqd_total)));
      txtnl(sep('-'));
      cmd(0x1B,0x61,0x01);
      if (lbls.cashier) txtnl((lbls.served_by||'Served by')+': '+lbls.cashier);
      txtnl(data.footer||lbls.thanks||'Thank you!');
    } else if (data.type === 'order') {
      cmd(0x1B,0x61,0x01); cmd(0x1B,0x21,0x30);
      txtnl(data.table||'Takeaway');
      cmd(0x1B,0x21,0x00); cmd(0x1B,0x61,0x00);
      var t=new Date(); var hh=t.getHours()%12||12; var mm2=String(t.getMinutes()).padStart(2,'0'); var ap=t.getHours()>=12?'PM':'AM';
      txtnl('Order #'+(data.order_id||'')+'   '+hh+':'+mm2+' '+ap);
      if (data.order_type) txtnl(data.order_type);
      if (data.note) txtnl('Note: '+data.note);
      txtnl(sep('-'));
      var items2=data.items||[];
      for (var ji=0;ji<items2.length;ji++) {
        var jt=items2[ji];
        cmd(0x1B,0x45,0x01);
        txtnl('x'+jt.qty+'  '+jt.name);
        cmd(0x1B,0x45,0x00);
        if (jt.note) txtnl('   >> '+jt.note);
      }
      txtnl(sep('='));
    }
    cmd(0x1B,0x64,0x06);
    cmd(0x1D,0x56,0x01);
    return Buffer.from(buf);
  }

  // ── HTTP server ──────────────────────────────────────────────────────────
  http.createServer(function(req, res) {
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Access-Control-Allow-Methods','POST,GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type');
    if (req.method==='OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method==='GET' && req.url==='/ping') {
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ok:true,version:'3.0',relay: !!RELAY_URL}));
      return;
    }
    if (req.method==='POST' && req.url==='/print') {
      var body='';
      req.on('data',function(d){ body+=d.toString(); });
      req.on('end',function() {
        var data;
        try { data=JSON.parse(body); } catch(e) {
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false,error:'Invalid JSON'})); return;
        }
        var ip=data.printer_ip; var pport=parseInt(data.printer_port)||9100;
        if (!ip) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'printer_ip required'})); return; }
        var buf;
        try { buf=buildEscPos(data); } catch(e) {
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false,error:'Build error: '+e.message})); return;
        }
        printTCP(ip,pport,buf)
          .then(function(){ res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true})); })
          .catch(function(e){ res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:e.message})); });
      });
      return;
    }
    res.writeHead(404); res.end();
  }).listen(PORT, '0.0.0.0', function() {
    var ips=[];
    Object.values(os.networkInterfaces()).forEach(function(a){a.forEach(function(i){if(i.family==='IPv4'&&!i.internal)ips.push(i.address);});});
    console.log('POS Print Agent v3.0');
    console.log('  Local:   http://127.0.0.1:'+PORT);
    ips.forEach(function(ip){ console.log('  Network: http://'+ip+':'+PORT); });
    if (RELAY_URL) console.log('  Relay:   '+RELAY_URL+' (iPad/cloud printing active)');
  });

  // ── Relay polling ────────────────────────────────────────────────────────
  function relayPoll() {
    if (!RELAY_URL || !AGENT_TOKEN) return;
    var parsed = url.parse(RELAY_URL+'/pos/agent/poll?token='+AGENT_TOKEN);
    var mod = parsed.protocol==='https:'?https:http;
    mod.get({host:parsed.hostname,port:parsed.port,path:parsed.path,headers:{'User-Agent':'POSAgent/3.0'}},function(r){
      var body=''; r.on('data',function(d){body+=d;}); r.on('end',function(){
        try {
          var resp=JSON.parse(body);
          (resp.jobs||[]).forEach(function(job){
            var p=typeof job.payload==='string'?JSON.parse(job.payload):job.payload;
            if(!p.printer_ip) return;
            var buf; try{buf=buildEscPos(p);}catch(e){return;}
            printTCP(p.printer_ip,parseInt(p.printer_port)||9100,buf).then(function(){
              var ap=url.parse(RELAY_URL+'/pos/agent/ack/'+job.id+'?token='+AGENT_TOKEN);
              var m2=ap.protocol==='https:'?https:http;
              var aq=m2.request({host:ap.hostname,port:ap.port,path:ap.path,method:'POST',headers:{'Content-Length':0}},function(){});
              aq.on('error',function(){}); aq.end();
            }).catch(function(){});
          });
        } catch(e){}
      });
    }).on('error',function(){});
  }
  setInterval(relayPoll, 2000);
}
