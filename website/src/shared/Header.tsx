import * as React from 'react';
import { Navbar, NavbarBrand, NavItem, NavLink } from 'reactstrap';

export const Header: React.FC = () => {
  return (
    <Navbar color="dark" dark={true} expand="md">
      <NavbarBrand href="/">
        Yopass <img width="40" height="40" alt="" src="yopass.svg" />
      </NavbarBrand>
      <NavItem>
        <NavLink href="/#/upload">Upload</NavLink>
      </NavItem>
    </Navbar>
  );
};
