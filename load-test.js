const axios = require('axios');

// Configuration
const TARGET_URL = 'http://localhost:3000/transactions/latest';
const CONCURRENT_REQUESTS = 100; // Number high enough to trigger the Rate Limit
const DELAY_BETWEEN_BATCHES_MS = 2000; // Wait 2 seconds between batches to read logs

// Helper function to pause execution
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runLoadTest() {
  console.log(`\n🚀 Starting Infinite Load Test against: ${TARGET_URL}`);
  console.log(`👥 Simulating ${CONCURRENT_REQUESTS} concurrent users per batch...`);
  console.log(`🛑 Press Ctrl+C to stop the script.\n`);

  let iteration = 1;

  // Infinite loop
  while (true) {
    console.log(`\n🔹 --- Batch #${iteration} ---`);
    
    const startTime = Date.now();
    const results = [];

    // Launch concurrent requests
    for (let i = 0; i < CONCURRENT_REQUESTS; i++) {
      const result = await axios.get(TARGET_URL)
        .then(response => ({
          success: true,
          status: response.status,
          dataLength: response.data ? response.data.length : 0
        }))
        .catch(error => ({
          success: false,
          status: error.response ? error.response.status : 'NETWORK_ERROR',
          message: error.message
        }));
      
      results.push(result);
    }

    // Wait for all requests in this batch to finish
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;

    // Analyze results
    const successes = results.filter(r => r.success).length;
    const failures = results.filter(r => !r.success).length;
    
    // Collect unique error codes (e.g., 429, 500)
    const uniqueErrors = [...new Set(results.filter(r => !r.success).map(r => r.status))];

    console.log('   📊 Batch Results:');
    console.log(`   ⏱️  Duration: ${duration} seconds`);
    console.log(`   ✅ Successful: ${successes}`);
    console.log(`   ❌ Failed:     ${failures}`);

    if (failures > 0) {
      console.log(`   ⚠️  Error Codes: ${uniqueErrors.join(', ')}`);
      
      if (uniqueErrors.includes(429)) {
        console.log('   🔥 CONCLUSION: Rate Limit Hit (429)! Caching likely OFF/Expired.');
      }
    } else {
      console.log('   ✨ CONCLUSION: Perfect Run! Caching is ON.');
    }

    iteration++;
    
    // Optional: Small delay between batches to make logs readable and prevent CPU lockup
    await sleep(DELAY_BETWEEN_BATCHES_MS);
  }
}

runLoadTest();