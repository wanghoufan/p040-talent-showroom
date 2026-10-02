import { NavLink } from 'react-router-dom';
export default function TalentNav() {
 return <nav className="talent-nav" aria-label="才艺分类"><NavLink to="/" end>舞蹈</NavLink><NavLink to="/repertoire/guitar">吉他</NavLink><NavLink to="/repertoire/vocal">唱歌</NavLink></nav>;
}
