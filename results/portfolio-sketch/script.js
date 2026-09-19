const root = document.documentElement;
const object = document.querySelector('.object-wrap');

window.addEventListener('pointermove', (event) => {
  const px = event.clientX / window.innerWidth - 0.5;
  const py = event.clientY / window.innerHeight - 0.5;
  object.style.setProperty('--x', `${px * 24}px`);
  object.style.setProperty('--y', `${py * 18}px`);
  object.style.setProperty('--rx', `${py * -7}deg`);
  object.style.setProperty('--ry', `${px * 9}deg`);
  root.style.setProperty('--pointer-x', `${event.clientX}px`);
  root.style.setProperty('--pointer-y', `${event.clientY}px`);
});
