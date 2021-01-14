import { Navbar, NavbarBrand, NavItem, NavLink } from 'reactstrap';


export const Header = () => {
  const base = process.env.PUBLIC_URL || '';
  const home = base + '/';
  const upload = base + '/#/upload';

  return (
    <Navbar color="dark" dark={true} expand="md">
      <NavbarBrand href={home}>
        Yopass <img width="40" height="40" alt="" src="yopass.svg" />
      </NavbarBrand>
      <NavItem>
        <NavLink href={upload}>Upload</NavLink>
      </NavItem>
    </Navbar>
  );
};
