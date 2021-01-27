import { createMuiTheme } from '@material-ui/core/styles';
import { blue, green } from '@material-ui/core/colors';

export const theme = createMuiTheme({
  palette: {
    primary: {
      main: blue[700],
    },
    secondary: {
      main: green[800],
    },
  },
});
