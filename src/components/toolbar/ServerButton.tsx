import Person from '@mui/icons-material/Person';
import Button from '@mui/material/Button/Button';
import React, { FC } from 'react';
import { Link } from 'react-router-dom';

const ServerButton: FC = () => {
    return (
        <Button
            variant='text'
            size='large'
            color='inherit'
            startIcon={
                <Person aria-hidden />
            }
            component={Link}
            to='/'
            sx={{
                minWidth: 'auto',
                px: 0,
                color: '#fff',
                fontFamily: '"Bebas Neue", "Netflix Sans", "Figtree", "Helvetica Neue", Arial, sans-serif',
                fontSize: '1.9rem',
                fontWeight: 400,
                letterSpacing: '0.06em',
                lineHeight: 1,
                textTransform: 'uppercase',
                '&:hover': {
                    backgroundColor: 'transparent',
                    color: '#fff'
                },
                '& .MuiButton-startIcon': {
                    mr: 1.1
                },
                '& .MuiButton-startIcon .MuiSvgIcon-root': {
                    fontSize: '2.15rem'
                }
            }}
        >
            Jellyfin
        </Button>
    );
};

export default ServerButton;
