import { VideoTile, type VideoTileProps } from './VideoTile'

export interface VideoGridProps {
  participants: VideoTileProps[]
}

export function VideoGrid({ participants }: VideoGridProps) {
  const count = participants.length

  const getGridClass = (n: number) => {
    if (n <= 1) return 'video-grid-1'
    if (n === 2) return 'video-grid-2'
    if (n <= 4) return 'video-grid-4'
    if (n <= 6) return 'video-grid-6'
    if (n <= 9) return 'video-grid-9'
    return 'video-grid-many'
  }

  return (
    <div className={`video-grid ${getGridClass(count)}`}>
      {participants.map((p) => (
        <VideoTile key={p.userId} {...p} />
      ))}
    </div>
  )
}
