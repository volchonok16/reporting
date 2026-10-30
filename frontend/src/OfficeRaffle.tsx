import { useEffect, useRef, useState } from 'react'
import { getJson } from './api'
import { notifyProblem } from './toast'

export type OfficeRafflePlace = {
  place: number
  gid: string
  name: string
  points: number
  members: string[]
}

type OfficeRaffleProps = {
  onClose: () => void
}

const BURST_COLORS = ['#FF3495', '#16D5DF', '#ffffff', '#000000']

export default function OfficeRaffle({ onClose }: OfficeRaffleProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [places, setPlaces] = useState<OfficeRafflePlace[] | null>(null)
  const [shown, setShown] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void getJson<{ places: OfficeRafflePlace[] }>('/api/product-status/b2b/raffle')
      .then((payload) => {
        if (!cancelled) setPlaces(payload.places)
      })
      .catch((err) => {
        if (!cancelled) {
          setError('Не удалось загрузить места')
          notifyProblem(err, 'Не удалось загрузить розыгрыш')
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!places || places.length === 0 || shown >= places.length) return
    const timer = window.setTimeout(() => setShown((current) => current + 1), shown === 0 ? 700 : 1700)
    return () => window.clearTimeout(timer)
  }, [places, shown])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    const particles: Array<{
      x: number
      y: number
      vx: number
      vy: number
      life: number
      color: string
      size: number
    }> = []

    const resize = () => {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
    }
    resize()
    window.addEventListener('resize', resize)

    const burst = (x: number, y: number) => {
      for (let index = 0; index < 42; index += 1) {
        const angle = (Math.PI * 2 * index) / 42 + Math.random() * 0.2
        const speed = 1.6 + Math.random() * 3.4
        particles.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 1,
          color: BURST_COLORS[index % BURST_COLORS.length],
          size: 2 + Math.random() * 3,
        })
      }
    }

    let frame = 0
    let raf = 0
    const tick = () => {
      frame += 1
      context.fillStyle = 'rgba(0, 0, 0, 0.22)'
      context.fillRect(0, 0, canvas.width, canvas.height)
      if (frame % 28 === 0) {
        burst(canvas.width * (0.2 + Math.random() * 0.6), canvas.height * (0.15 + Math.random() * 0.35))
      }
      for (let index = particles.length - 1; index >= 0; index -= 1) {
        const particle = particles[index]
        particle.x += particle.vx
        particle.y += particle.vy
        particle.vy += 0.02
        particle.life -= 0.012
        if (particle.life <= 0) {
          particles.splice(index, 1)
          continue
        }
        context.globalAlpha = Math.max(particle.life, 0)
        context.fillStyle = particle.color
        context.fillRect(particle.x, particle.y, particle.size, particle.size)
      }
      context.globalAlpha = 1
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => {
      window.cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  const finished = Boolean(places && shown >= places.length)
  const current = places && shown > 0 ? places[shown - 1] : null

  return (
    <div className="office-raffle" role="dialog" aria-modal="true" aria-label="Розыгрыш баллов">
      <canvas ref={canvasRef} className="office-raffle-canvas" />
      <div className="office-raffle-confetti" aria-hidden="true">
        {Array.from({ length: 28 }, (_, index) => (
          <span key={index} style={{ left: `${(index * 37) % 100}%`, animationDelay: `${(index % 8) * 0.18}s` }} />
        ))}
      </div>
      <button type="button" className="btn-secondary office-raffle-close" onClick={onClose}>
        Закрыть
      </button>
      <div className="office-raffle-stage">
        {error ? <p className="office-raffle-empty">{error}</p> : null}
        {places && places.length === 0 ? <p className="office-raffle-empty">Офисов нет.</p> : null}
        {!finished && current ? (
          <article className="office-raffle-spotlight" key={current.gid}>
            <p className="office-raffle-place">{current.place} место</p>
            <h2>{current.name}</h2>
            <p className="office-raffle-points">{current.points} баллов</p>
            <p className="office-raffle-members">
              {current.members.length ? current.members.join(', ') : 'Состав не задан'}
            </p>
          </article>
        ) : null}
        {finished && places ? (
          <div className="office-raffle-sheet">
            <h2>Итоги</h2>
            <ol>
              {places.map((item) => (
                <li key={item.gid}>
                  <p className="office-raffle-place">{item.place} место</p>
                  <h3>{item.name}</h3>
                  <p className="office-raffle-points">{item.points} баллов</p>
                  <p className="office-raffle-members">
                    {item.members.length ? item.members.join(', ') : 'Состав не задан'}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
    </div>
  )
}
