import { NavLink } from 'react-router-dom';
import { SHOW_LINKS } from '../app/routes';

/**
 * 顶部演出专区（V1.3-R2 §8）：今晚节目单 / 演出模式。
 * 才艺类别改由底部四主 Tab 承担，这里不再重复展示「舞蹈 / 唱歌 / 吉他」。
 */
export default function TalentNav() {
  return (
    <nav className="perf-nav" aria-label="演出专区">
      <span className="perf-nav__label" aria-hidden="true">演出</span>
      {SHOW_LINKS.map((link) => (
        <NavLink
          key={link.path}
          to={link.path}
          className={({ isActive }) => (isActive ? 'perf-nav__link perf-nav__link--active' : 'perf-nav__link')}
        >
          {link.label}
        </NavLink>
      ))}
    </nav>
  );
}
