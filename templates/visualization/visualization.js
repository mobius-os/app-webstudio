const data = Array.isArray(window.VISUALIZATION_DATA) ? window.VISUALIZATION_DATA : []
const chart = document.querySelector('#chart')
const valueLabel = document.querySelector('#value')
const dayLabel = document.querySelector('#label')
const note = document.querySelector('#note')
const max = Math.max(1, ...data.map(item => Number(item.hours) || 0))

function show(item) {
  valueLabel.textContent = `${Number(item.hours).toFixed(1)} hours`
  dayLabel.textContent = item.name
}

for (const item of data) {
  const group = document.createElement('div')
  group.className = 'bar-group'
  const bar = document.createElement('button')
  bar.className = 'bar'
  bar.type = 'button'
  bar.style.setProperty('--h', `${Math.max(3, (Number(item.hours) || 0) / max * 92)}%`)
  bar.setAttribute('aria-label', `${item.name}: ${Number(item.hours).toFixed(1)} hours`)
  bar.addEventListener('mouseenter', () => show(item))
  bar.addEventListener('focus', () => show(item))
  const label = document.createElement('small')
  label.textContent = item.day
  group.append(bar, label)
  chart.append(group)
}
if (data.length) {
  const strongest = data.reduce((best, item) => Number(item.hours) > Number(best.hours) ? item : best)
  show(data[0])
  note.textContent = `${strongest.name} was the strongest day at ${Number(strongest.hours).toFixed(1)} focused hours.`
} else {
  chart.classList.add('empty')
  note.textContent = 'Add rows to data.js to begin.'
}
