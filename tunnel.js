const localtunnel = require('localtunnel');

(async () => {
  const tunnel = await localtunnel({ port: 3456 });

  console.log('========================================');
  console.log('  Public URL: ' + tunnel.url);
  console.log('========================================');

  tunnel.on('close', () => {
    console.log('Tunnel closed');
    process.exit(1);
  });

  tunnel.on('error', (err) => {
    console.error('Tunnel error:', err.message);
    // Don't exit — localtunnel will try to reconnect
  });
})();
