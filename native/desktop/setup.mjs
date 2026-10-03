const form = document.querySelector('form');
const input = document.querySelector('input');
input.value = await window.connection.current();
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button'); button.disabled = true;
  const status = document.querySelector('#status'); status.textContent = '연결 중…';
  try { await window.connection.connect(input.value); } catch (error) { status.textContent = error.message; }
  finally { button.disabled = false; }
});
