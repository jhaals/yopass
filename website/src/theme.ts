import { createTheme } from '@mui/material/styles';
import { blueGrey } from '@mui/material/colors';

export const theme = createTheme({
  colorSchemes: {
    dark: {
      palette: {
        background: {
          default: '#222',
        },
      },
    },
    light: {
      palette: {
        primary: blueGrey,
        background: {
          paper: '#ecf0f1',
        },
      },
    },
  },
});
