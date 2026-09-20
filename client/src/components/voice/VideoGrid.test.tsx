import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { VideoGrid } from './VideoGrid'
import { VideoTile } from './VideoTile'

describe('VideoTile Component', () => {
  it('renders avatar fallback and participant name without video stream', () => {
    const html = renderToString(
      <VideoTile
        userId="user-123"
        displayName="Alice"
        isSelf={false}
        stream={null}
        speaking={false}
        selfMute={false}
        selfDeaf={false}
      />
    )

    expect(html).toContain('Alice')
    expect(html).toContain('video-tile-fallback')
    expect(html).toContain('AL')
  })

  it('applies mirror class and muted attribute for local participant', () => {
    const html = renderToString(
      <VideoTile
        userId="user-self"
        displayName="Bob"
        isSelf={true}
        stream={null}
        speaking={false}
        selfMute={false}
        selfDeaf={false}
      />
    )

    expect(html).toContain('video-tile-mirror')
    expect(html).toContain('(You)')
    expect(html).toContain('muted=""')
  })

  it('renders speaking border and mute badges', () => {
    const html = renderToString(
      <VideoTile
        userId="user-456"
        displayName="Charlie"
        isSelf={false}
        stream={null}
        speaking={true}
        selfMute={true}
        selfDeaf={true}
      />
    )

    expect(html).toContain('video-tile speaking')
    expect(html).toContain('deafened')
    expect(html).toContain('muted')
  })
})

describe('VideoGrid Component', () => {
  it('applies responsive grid classes based on participant count', () => {
    const p1 = {
      userId: 'u1',
      displayName: 'User 1',
      isSelf: true,
      stream: null,
      speaking: false,
    }

    const grid1 = renderToString(<VideoGrid participants={[p1]} />)
    expect(grid1).toContain('video-grid video-grid-1')

    const p2 = { ...p1, userId: 'u2', displayName: 'User 2', isSelf: false }
    const grid2 = renderToString(<VideoGrid participants={[p1, p2]} />)
    expect(grid2).toContain('video-grid video-grid-2')

    const p3 = { ...p1, userId: 'u3', displayName: 'User 3', isSelf: false }
    const p4 = { ...p1, userId: 'u4', displayName: 'User 4', isSelf: false }
    const grid4 = renderToString(<VideoGrid participants={[p1, p2, p3, p4]} />)
    expect(grid4).toContain('video-grid video-grid-4')

    const p5 = { ...p1, userId: 'u5', displayName: 'User 5', isSelf: false }
    const p6 = { ...p1, userId: 'u6', displayName: 'User 6', isSelf: false }
    const grid6 = renderToString(<VideoGrid participants={[p1, p2, p3, p4, p5, p6]} />)
    expect(grid6).toContain('video-grid video-grid-6')
  })
})
