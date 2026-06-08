async function test() {
  try {
    const res = await fetch('http://localhost:3001/api/blockers/9/discussions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer user-token-1'
      },
      body: JSON.stringify({ message: 'test message' })
    });
    console.log(res.status);
    console.log(await res.text());
  } catch (e) {
    console.error('Fetch error:', e);
  }
}
test();
