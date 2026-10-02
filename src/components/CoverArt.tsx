export default function CoverArt({ title, variant = 'card' }: { title: string; variant?: 'card' | 'detail' }) {
  return (
    <div className={`cover-art cover-art--${variant}`} aria-hidden="true">
      <span className="cover-art__glyph">♪</span>
      <span className="cover-art__text">{title}</span>
      <span className="cover-art__bar" />
    </div>
  );
}
